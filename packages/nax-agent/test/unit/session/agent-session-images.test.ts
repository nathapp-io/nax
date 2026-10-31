import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  AgentSessionError,
  createAgentSession,
  type ImageAttachment,
  type OpenedBackend,
  type SendTurnOpts,
} from "@nathapp/nax-agent";
import { collect, reader, sessionOptions, turnEndOf } from "#test/helpers/agent-session";
import { assertDefined } from "#test/helpers/index";

const img: ImageAttachment = { mimeType: "image/png", data: "AAAA" };
const invalid = { images: [{ mimeType: "image/bmp", data: "AAAA" }] };
const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function setup(answer: boolean | undefined = true) {
  const calls: { prompt: string; opts: SendTurnOpts }[] = [];
  const opened: OpenedBackend = {
    adapter: {
      openSession: async () => ({ id: "fake", agentName: "fake" }),
      sendTurn: async (_handle, prompt, opts) => {
        calls.push({ prompt, opts });
        return {
          output: "ok",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
        };
      },
      closeSession: async () => {},
    },
    handle: { id: "fake", agentName: "fake" },
    info: { kind: "fake", capabilities: {} },
    turnOpts: () => ({ interactionHandler: { onInteraction: async () => null } }),
    close: async () => {},
    ...(answer === undefined ? {} : { acceptsImages: async () => answer }),
  };
  const session = await createAgentSession(sessionOptions({ backend: { kind: "fake", open: async () => opened } }));
  sessions.push(session);
  return { session, calls, opened };
}

function expectRefusal(action: () => unknown, code: string, capability?: string): void {
  expect(action).toThrow(AgentSessionError);
  expect(action).toThrow(
    expect.objectContaining({
      code,
      ...(capability === undefined ? {} : { context: expect.objectContaining({ capability }) }),
    }),
  );
}

describe("AgentSession image input", () => {
  test("AC-1: carries images and prompt to sendTurn", async () => {
    const { session, calls } = await setup();
    expect(turnEndOf(await collect(session.send("look", { images: [img] }))).status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ prompt: "look", opts: { images: [img] } });
  });
  test.each([undefined, { images: [] }])("AC-2/3: omits the images key for %j", async (input) => {
    const { session, calls } = await setup();
    await collect(session.send("look", input));
    assertDefined(calls[0]);
    expect(calls[0].prompt).toBe("look");
    expect(Object.hasOwn(calls[0].opts, "images")).toBe(false);
  });
  test("AC-4/5/6: invalid input refuses synchronously without claiming a turn", async () => {
    const { session, calls } = await setup();
    expectRefusal(() => session.send("look", invalid), "AGENT_SESSION_INVALID_INPUT");
    expect(calls).toEqual([]);
    await collect(session.send("next"));
    expect(calls.map((call) => call.prompt)).toEqual(["next"]);
  });
  test("AC-7/8/9: missing capability refuses images but allows text", async () => {
    const { session, calls, opened } = await setup();
    delete opened.acceptsImages;
    expectRefusal(() => session.send("look", { images: [img] }), "AGENT_SESSION_CAPABILITY_UNSUPPORTED", "images");
    expect(calls).toEqual([]);
    await collect(session.send("look"));
    expect(calls.map((call) => call.prompt)).toEqual(["look"]);
  });
  test("AC-10: busy precedes validation during a running turn", async () => {
    const { session, opened } = await setup();
    const gate = Promise.withResolvers<void>();
    const send = opened.adapter.sendTurn;
    opened.adapter.sendTurn = async (...args) => {
      await gate.promise;
      return send(...args);
    };
    const stream = reader(session.send("first"));
    await stream.until("turn_start");
    try {
      expectRefusal(() => session.send("look", invalid), "AGENT_SESSION_BUSY");
    } finally {
      gate.resolve();
      await stream.rest();
    }
  });
  test.each([
    ["AC-11", undefined, false],
    ["AC-12", true, true],
    ["AC-13", false, false],
  ] as const)("%s: capability query delegates or defaults false", async (_ac, answer, expected) => {
    const { session, opened } = await setup(answer);
    if (answer === undefined) delete opened.acceptsImages;
    assertDefined(session.acceptsImages);
    expect(await session.acceptsImages()).toBe(expected);
  });
  test("AC-14: closed capability query rejects CLOSED", async () => {
    const { session } = await setup();
    await session.close();
    assertDefined(session.acceptsImages);
    await expect(session.acceptsImages()).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_CLOSED",
    });
  });
  test("AC-15: invalid input is a public error code", () => {
    expect(new AgentSessionError("x", "AGENT_SESSION_INVALID_INPUT").code).toBe("AGENT_SESSION_INVALID_INPUT");
  });
  test("send never queries capability, even when its answer is false", async () => {
    const { session, opened, calls } = await setup(false);
    let queried = false;
    opened.acceptsImages = async () => {
      queried = true;
      return false;
    };
    await collect(session.send("look", { images: [img] }));
    expect(queried).toBe(false);
    expect(calls[0]).toMatchObject({ opts: { images: [img] } });
  });
});
