import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import {
  type AgentSession,
  createAgentSession,
  createMemoryTranscriptStore,
  type ImageAttachment,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { _acpBackendDeps, acpBackend } from "#src/client/backend";
import { DENIED_CONTINUATION_PROMPT } from "#src/client/turn";
import type { FakeScript } from "#test/fixtures/fake-agent/script";
import { type InMemoryAgent, inMemoryAgent } from "#test/helpers/in-memory-launch";
import { endOf } from "#test/helpers/session-events";

const img: ImageAttachment = {
  mimeType: "image/png",
  data: "AAAA",
  width: 10,
  height: 20,
  source: "clipboard",
};
const other: ImageAttachment = { mimeType: "image/jpeg", data: "BBBB" };
const block = (image: ImageAttachment) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data });
const originalLaunch = _acpBackendDeps.launch;
const sessions: AgentSession[] = [];
let workdir: string;
beforeEach(() => {
  workdir = makeTempDir("acp-images-");
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  _acpBackendDeps.launch = originalLaunch;
  cleanupTempDir(workdir);
});

async function open(script: FakeScript = {}, instructions?: string) {
  const fake = inMemoryAgent({ capabilities: { promptCapabilities: { image: true } }, ...script });
  _acpBackendDeps.launch = fake.launch;
  const session = await createAgentSession({
    backend: acpBackend({ agent: { name: "fake", command: "fake" }, allowUnsandboxed: true }),
    profile: "full",
    workdir,
    transcriptStore: createMemoryTranscriptStore(),
    ...(instructions === undefined ? {} : { instructions }),
  });
  sessions.push(session);
  return { fake, session };
}
async function send(session: AgentSession, images?: readonly ImageAttachment[]) {
  const events: SessionEvent[] = [];
  for await (const event of session.send("look", images === undefined ? undefined : { images })) events.push(event);
  return endOf(events);
}
const prompts = (fake: InMemoryAgent) =>
  (fake.callsTo("session/prompt") as readonly PromptRequest[]).map((p) => p.prompt);

// All sends go through the public facade, including validation and SendTurnOpts forwarding.
describe("ACP image input", () => {
  test.each([true, false, undefined])("AC-4/5: session advertises image capability %p", async (image) => {
    const capabilities = image === undefined ? {} : { promptCapabilities: { image } };
    const { session } = await open({ capabilities });
    expect(await session.acceptsImages?.()).toBe(image === true);
  });

  test("AC-6/8: sends one image without display metadata before text", async () => {
    const { fake, session } = await open();
    expect((await send(session, [img])).status).toBe("completed");
    expect(prompts(fake)).toEqual([[block(img), { type: "text", text: "look" }]]);
  });

  test("AC-7: preserves two-image order", async () => {
    const { fake, session } = await open();
    await send(session, [img, other]);
    expect(prompts(fake)).toEqual([[block(img), block(other), { type: "text", text: "look" }]]);
  });

  test("AC-9: text-only turns keep their exact wire shape", async () => {
    const { fake, session } = await open();
    expect((await send(session)).status).toBe("completed");
    expect(prompts(fake)).toEqual([[{ type: "text", text: "look" }]]);
  });

  test("AC-10: first-turn instructions join only the text block", async () => {
    const { fake, session } = await open({}, "Be brief.");
    await send(session, [img]);
    await send(session, [other]);
    expect(prompts(fake)).toEqual([
      [block(img), { type: "text", text: "Be brief.\n\nlook" }],
      [block(other), { type: "text", text: "look" }],
    ]);
  });

  test.each([false, undefined])("AC-11/12: unsupported images (%p) error before any prompt", async (image) => {
    const capabilities = image === undefined ? {} : { promptCapabilities: { image } };
    const { fake, session } = await open({ capabilities });
    const end = await send(session, [img]);
    expect(end).toMatchObject({ status: "errored", error: { code: "ACP_IMAGE_INPUT_UNSUPPORTED" } });
    expect(prompts(fake)).toEqual([]);
    expect((await send(session)).status).toBe("completed");
  });

  test("AC-13: denied continuation sends text only, without replaying images", async () => {
    const { fake, session } = await open({
      turns: [
        { steps: [{ kind: "permission", options: ["reject_once"] }], stopReason: "cancelled" },
        { steps: [{ kind: "text", text: "done" }] },
      ],
    });
    expect((await send(session, [img])).status).toBe("completed");
    expect(prompts(fake)).toEqual([
      [block(img), { type: "text", text: "look" }],
      [{ type: "text", text: DENIED_CONTINUATION_PROMPT }],
    ]);
  });

  test("AC-14/15: capability query never reconnects and follows the replacement process", async () => {
    const { fake, session } = await open({
      capabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } },
      relaunch: { capabilities: { sessionCapabilities: { resume: {} } } },
    });
    fake.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await session.acceptsImages?.()).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect((await send(session)).status).toBe("completed");
    expect(fake.requests).toHaveLength(2);
    expect(await session.acceptsImages?.()).toBe(false);
    expect(await send(session, [img])).toMatchObject({
      status: "errored",
      error: { code: "ACP_IMAGE_INPUT_UNSUPPORTED" },
    });
    expect(prompts(fake)).toEqual([[{ type: "text", text: "look" }]]);
  });

  test("image refusal checks the replacement record before its first prompt", async () => {
    const { fake, session } = await open({
      capabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } },
      relaunch: { capabilities: { promptCapabilities: { image: false }, sessionCapabilities: { resume: {} } } },
    });
    fake.crash();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await send(session, [img])).toMatchObject({ error: { code: "ACP_IMAGE_INPUT_UNSUPPORTED" } });
    expect(fake.requests).toHaveLength(2);
    expect(prompts(fake)).toEqual([]);
  });
});
