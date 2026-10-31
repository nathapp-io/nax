import { afterEach, describe, expect, test } from "bun:test";
import { type AgentSession, createAgentSession, type ImageAttachment, nativeBackend } from "@nathapp/nax-agent";
import { collect, sessionOptions, turnEndOf } from "#test/helpers/agent-session";
import { assertDefined, cleanupTempDir, installImageClient, makeTempDir } from "#test/helpers/index";

const img: ImageAttachment = { mimeType: "image/png", data: "AAAA" };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(input: readonly ("text" | "image")[]) {
  const client = installImageClient(input);
  cleanups.push(client.restore);
  const dir = makeTempDir("native-images-integration-");
  cleanups.push(() => cleanupTempDir(dir));
  const session: AgentSession = await createAgentSession(
    sessionOptions({
      workdir: dir,
      backend: nativeBackend({ model: "stub/stub-model" }),
    }),
  );
  cleanups.push(() => session.close());
  return { session, requests: client.requests, modelCalls: client.modelCalls };
}

describe("nativeBackend image input through createAgentSession", () => {
  test("AC-11: sends validated images through the native model stream", async () => {
    const { session, requests } = await setup(["text", "image"]);
    const end = turnEndOf(await collect(session.send("look", { images: [img] })));
    expect(end.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)).toEqual({ role: "user", content: "look", images: [img] });
  });

  test("AC-12: text-only model ends the turn with the native refusal code", async () => {
    const { session, requests } = await setup(["text"]);
    const end = turnEndOf(await collect(session.send("look", { images: [img] })));
    expect(end.status).toBe("errored");
    expect(end.error).toMatchObject({ code: "NATIVE_IMAGE_INPUT_UNSUPPORTED" });
    expect(requests).toHaveLength(0);
  });

  test.each([
    ["AC-13", ["text", "image"], true],
    ["AC-14", ["text"], false],
  ] as const)("%s: exposes current model capability", async (_ac, input, expected) => {
    const { session, modelCalls } = await setup(input);
    assertDefined(session.acceptsImages);
    expect(await session.acceptsImages()).toBe(expected);
    expect(modelCalls).toEqual([["stub", "stub-model"]]);
  });
});
