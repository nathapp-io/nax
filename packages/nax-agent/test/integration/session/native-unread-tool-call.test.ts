/**
 * US-002: a native reply holding a literal `<tool_call>` block gets one
 * follow-up asking the model to call through the tool interface. Observed
 * through the scripted provider's recorded requests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type AgentSession, createAgentSession, type EmbedderTool } from "@nathapp/nax-agent";
import type { ClientRequest, ProtocolEvent } from "@nathapp/nax-ai";
import { createLoopEventRegistry } from "#src/native/session/loop-events/index";
import { createNativeSessionState } from "#src/native/session/session";
import { runNativeTurn } from "#src/native/session/turn-loop";
import { createTurnDeadline } from "#src/session/turn-deadline";
import {
  collect,
  installScriptedProvider,
  resetScriptedProvider,
  type ScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import { assertDefined, cleanupTempDir, makeTempDir, seedNativeSession } from "#test/helpers/index";

const BLOCK = '<tool_call>{"name":"ScrashpadWrite"}</tool_call>';
const PREFIX = "Your reply contains a <tool_call> block that was not run";

const sessions: AgentSession[] = [];
afterEach(async () => {
  try {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  } finally {
    resetScriptedProvider();
  }
});

function probeTool(onProbe: () => void = () => {}): EmbedderTool {
  return {
    name: "probe",
    description: "a probe",
    inputSchema: { type: "object", properties: { step: { type: "number" } }, required: ["step"] },
    approval: "never",
    async run() {
      onProbe();
      return { content: "probe ok" };
    },
  };
}

async function openSession(extra: Parameters<typeof sessionOptions>[0] = {}) {
  const session = await createAgentSession(sessionOptions({ tools: [probeTool()], ...extra }));
  sessions.push(session);
  return session;
}

function lastMessage(provider: ScriptedProvider, index: number): ClientRequest["messages"][number] {
  const message = provider.requests.at(index)?.messages.at(-1);
  assertDefined(message, `last message of request ${index}`);
  return message;
}

/** Text then a tool call, in one round. */
function textThenCall(text: string, id: string, input: Record<string, unknown>): ProtocolEvent[] {
  return [
    { type: "text-delta", text },
    { type: "tool-call", call: { id, name: "probe", input } },
    { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
    { type: "done", stopReason: "tool_use" },
  ];
}

describe("native unread tool-call follow-up", () => {
  test("AC-1, AC-2: one follow-up listing the tools the first request declared", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound(BLOCK), textRound("done"));
    const session = await openSession();

    await collect(session.send("hi"));

    expect(provider.requests).toHaveLength(2);
    const message = lastMessage(provider, 1);
    expect(message.role).toBe("user");
    expect(message.role === "user" ? message.content : "").toStartWith(PREFIX);
    const declared = (provider.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(declared).toContain("probe");
    expect(message.role === "user" ? message.content : "").toEndWith(
      `using one of these exact names: ${declared.join(", ")}.`,
    );
  });

  test("AC-3: a block on every round sends exactly two requests and completes", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound(BLOCK), textRound(BLOCK), textRound(BLOCK));
    const session = await openSession();

    const events = await collect(session.send("hi"));

    expect(provider.requests).toHaveLength(2);
    expect(turnEndOf(events).status).toBe("completed");
  });

  test("AC-4: plain text sends one request", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("plain"));
    const session = await openSession();
    await collect(session.send("hi"));
    expect(provider.requests).toHaveLength(1);
  });

  test("AC-5: a real tool call then block text sends exactly one follow-up", async () => {
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "t1", name: "probe", input: { step: 1 } }]), textRound(BLOCK), textRound(BLOCK));
    const session = await openSession();

    await collect(session.send("hi"));

    expect(provider.requests).toHaveLength(3);
    const message = lastMessage(provider, 2);
    expect(message.role === "user" ? message.content : "").toStartWith(PREFIX);
  });

  test("AC-6: a plugin followUp wins over the built-in one", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound(BLOCK), textRound("done"));
    const session = await openSession({
      loopHandlers: [
        {
          plugin: "test",
          event: "before_turn_end",
          handler: (payload) =>
            "followUpsSoFar" in payload && payload.followUpsSoFar === 0 ? { followUp: "plugin text" } : {},
        },
      ],
    });

    await collect(session.send("hi"));

    expect(provider.requests).toHaveLength(2);
    expect(lastMessage(provider, 1)).toEqual({ role: "user", content: "plugin text" });
  });

  test("AC-7: an invalid-call budget stop sends no follow-up", async () => {
    const provider = installScriptedProvider();
    provider.push(
      textThenCall(BLOCK, "c1", { step: "x" }),
      textThenCall(BLOCK, "c2", { step: "x" }),
      textThenCall(BLOCK, "c3", { step: "x" }),
      textRound("never sent"),
    );
    const session = await openSession();

    await collect(session.send("hi"));

    expect(provider.requests).toHaveLength(3);
  });

  test("AC-8: a cancelled turn sends no follow-up", async () => {
    const provider = installScriptedProvider();
    // The first call cancels mid-batch; the batch's abort check ends the turn as cancelled.
    provider.push(
      [
        { type: "text-delta", text: BLOCK },
        { type: "tool-call", call: { id: "t1", name: "probe", input: { step: 1 } } },
        { type: "tool-call", call: { id: "t2", name: "probe", input: { step: 2 } } },
        { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
        { type: "done", stopReason: "tool_use" },
      ],
      textRound("never sent"),
    );
    let cancel: () => void = () => {};
    const session = await openSession({ tools: [probeTool(() => cancel())] });
    cancel = () => session.cancel();

    const events = await collect(session.send("hi"));

    expect(turnEndOf(events).status).toBe("cancelled");
    expect(provider.requests).toHaveLength(1);
  });

  test("AC-9: the once-per-turn flag does not carry over to the next send", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound(BLOCK), textRound("done"), textRound(BLOCK), textRound("done"));
    const session = await openSession();

    await collect(session.send("one"));
    await collect(session.send("two"));

    expect(provider.requests).toHaveLength(4);
    const message = lastMessage(provider, 3);
    expect(message.role === "user" ? message.content : "").toStartWith(PREFIX);
  });

  test("AC-13: a spin stop sends no unread-tool-call follow-up", async () => {
    const provider = installScriptedProvider();
    provider.push(...Array.from({ length: 60 }, (_, i) => textThenCall(BLOCK, `s${i}`, { step: 1 })));
    const session = await openSession();

    await collect(session.send("hi"));

    const followUps = provider.requests.filter((request) => {
      const last = request.messages.at(-1);
      return last?.role === "user" && last.content.startsWith(PREFIX);
    });
    expect(followUps).toHaveLength(0);
  });
});

describe("native unread tool-call follow-up: direct turn loop", () => {
  const handle = { id: "sess-unread-direct", agentName: "native" } as const;
  const usage = { inputTokens: 1, outputTokens: 1 };

  test("AC-12: a reused caller-supplied registry gives each turn its own follow-up", async () => {
    const dir = makeTempDir("nax-unread-tool-call-");
    try {
      const sessionState = seedNativeSession(createNativeSessionState(), handle.id, { transcriptDir: dir });
      const registry = createLoopEventRegistry();
      let calls = 0;
      const sent: string[] = [];
      const complete = async (messages: readonly { role: string; content?: string }[]) => {
        calls += 1;
        const last = messages.at(-1);
        if (last?.role === "user" && last.content?.startsWith(PREFIX)) sent.push(last.content);
        return { text: calls % 2 === 1 ? BLOCK : "done", usage, costUsd: 0 };
      };
      const opts = { interactionHandler: { onInteraction: async () => ({ answer: "ok" }) } };
      await runNativeTurn(handle, "one", opts, { sessionState, loopEvents: registry, complete });
      await runNativeTurn(handle, "two", opts, { sessionState, loopEvents: registry, complete });

      expect(calls).toBe(4);
      expect(sent).toHaveLength(2);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("AC-13: a deadline stop sends no unread-tool-call follow-up", async () => {
    const dir = makeTempDir("nax-unread-tool-call-");
    try {
      const sessionState = seedNativeSession(createNativeSessionState(), handle.id, { transcriptDir: dir });
      let now = 0;
      let calls = 0;
      const result = await runNativeTurn(
        handle,
        "hi",
        { interactionHandler: { onInteraction: async () => ({ answer: "ok" }) } },
        {
          sessionState,
          deadline: createTurnDeadline(30, () => now),
          complete: async () => {
            calls += 1;
            now += 20_000;
            return { text: BLOCK, toolCalls: [{ id: "c1", name: "query_neighbor", input: {} }], usage, costUsd: 0 };
          },
        },
      );
      expect(result.timedOut).toBe(true);
      expect(calls).toBe(2);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
