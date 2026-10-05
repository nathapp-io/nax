/**
 * The agent session facade on real Node (S3 spec 8): multi-turn chat, deltas,
 * coalescing and stream_reset, an always-approval embedder tool allowed,
 * denied and timed out, an answer at the deadline, questions, cancel during a
 * tool, iterator break, close during a turn, and the none/read tool sets.
 * Every session brings a memory credentials source; nothing here calls
 * configureCredentials.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type CreateAgentSessionOptions,
  type CredentialSource,
  createAgentSession,
  type EmbedderTool,
  type EmbedderToolContext,
} from "#src/index";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import {
  collect,
  eventsOf,
  faultRound,
  installManualTimers,
  installScriptedProvider,
  reader,
  resetScriptedProvider,
  type SessionTestOptions,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
  types,
  untilSettled,
} from "#test/helpers/agent-session";

const APPROVAL_MS = 30_000;
const CREDENTIALS: CredentialSource = { kind: "memory", credentials: { openai: { kind: "api-key", key: "sk-node" } } };
const SAVED_DEPS = { ..._agentSessionDeps };

afterEach(() => {
  Object.assign(_agentSessionDeps, SAVED_DEPS);
  resetScriptedProvider();
});

function nodeOptions(extra: SessionTestOptions = {}): CreateAgentSessionOptions {
  return sessionOptions({ credentials: CREDENTIALS, approvalTimeoutMs: APPROVAL_MS, ...extra });
}

function lookupTool(approval: "never" | "always", runs: unknown[]): EmbedderTool {
  return {
    name: "lookup",
    description: "look a record up",
    inputSchema: { type: "object", properties: { id: { type: "number" } } },
    approval,
    async run(input) {
      runs.push(input);
      return { content: "record 42" };
    },
  };
}

/** Ignores its signal and never settles: the facade must abandon it. */
function stuckTool(seen: EmbedderToolContext[]): EmbedderTool {
  return {
    name: "wait",
    description: "wait for something",
    inputSchema: { type: "object" },
    approval: "never",
    run(_input, ctx) {
      seen.push(ctx);
      return new Promise(() => {});
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("agent session on Node: chat and streaming", () => {
  test("two turns stream deltas and usage and carry history", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("Hello"), textRound("Again"));
    const session = await createAgentSession(nodeOptions({ sessionId: "node-chat" }));
    const first = await collect(session.send("hi"));
    expect(types(first)).toEqual(["turn_start", "text_delta", "usage", "turn_end"]);
    expect(turnEndOf(first)).toMatchObject({ status: "completed", output: "Hello" });
    const second = await collect(session.send("again"));
    expect(turnEndOf(second).output).toBe("Again");
    expect(provider.requests[1]?.messages).toEqual([
      { role: "user", content: "hi" },
      expect.objectContaining({ role: "assistant", content: "Hello" }),
      { role: "user", content: "again" },
    ]);
    await session.close();
  });

  test("a lagging consumer gets the adjacent deltas of one round coalesced", async () => {
    const provider = installScriptedProvider();
    provider.push([
      { type: "text-delta", text: "a" },
      { type: "text-delta", text: "b" },
      { type: "text-delta", text: "c" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 3 } },
      { type: "done", stopReason: "stop" },
    ]);
    const session = await createAgentSession(nodeOptions());
    const events = reader(session.send("spell it"));
    await events.until("turn_start");
    await untilSettled(session, undefined);
    const rest = await events.rest();
    expect(eventsOf(rest, "text_delta").map((event) => event.text)).toEqual(["abc"]);
    expect(turnEndOf(rest).output).toBe("abc");
    await session.close();
  });

  test("a transport fault after streamed text is retried with stream_reset", async () => {
    const provider = installScriptedProvider();
    provider.push(faultRound("stale"), textRound("fresh"));
    const session = await createAgentSession(nodeOptions());
    const events = await collect(session.send("hi"));
    expect(types(events)).toEqual(["turn_start", "text_delta", "stream_reset", "text_delta", "usage", "turn_end"]);
    expect(turnEndOf(events)).toMatchObject({ status: "completed", output: "fresh" });
    await session.close();
  });
});

describe("agent session on Node: approvals and questions", () => {
  test("an always-approval tool: allowed runs, denied does not, unanswered times out, a late answer is expired", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "c1", name: "lookup", input: { id: 1 } }]),
      textRound("allowed"),
      toolRound([{ id: "c2", name: "lookup", input: { id: 2 } }]),
      textRound("denied"),
      toolRound([{ id: "c3", name: "lookup", input: { id: 3 } }]),
      textRound("timed out"),
    );
    const runs: unknown[] = [];
    const session = await createAgentSession(nodeOptions({ tools: [lookupTool("always", runs)] }));

    const allow = reader(session.send("one"));
    const [first] = eventsOf(await allow.until("approval_requested"), "approval_requested");
    expect(first).toMatchObject({ callId: "c1", tool: "lookup" });
    expect(session.answer(first?.requestId ?? "", { decision: "allow" })).toBe("accepted");
    const allowRest = await allow.rest();
    expect(eventsOf(allowRest, "approval_resolved")[0]).toMatchObject({ decision: "allow", decidedBy: "human" });
    expect(turnEndOf(allowRest).status).toBe("completed");

    const deny = reader(session.send("two"));
    const [second] = eventsOf(await deny.until("approval_requested"), "approval_requested");
    session.answer(second?.requestId ?? "", { decision: "deny" });
    // A denial is a refusal the model reads, not an error result (as the bun denial test pins).
    expect(eventsOf(await deny.rest(), "tool_result")[0]?.preview).toContain("Denied");

    const timeout = reader(session.send("three"));
    const [third] = eventsOf(await timeout.until("approval_requested"), "approval_requested");
    expect(timers.fire(APPROVAL_MS)).toBe(1);
    const timeoutRest = await timeout.rest();
    expect(eventsOf(timeoutRest, "approval_resolved")[0]).toMatchObject({ decision: "deny", decidedBy: "timeout" });
    expect(session.answer(third?.requestId ?? "", { decision: "allow" })).toBe("expired");

    expect(runs).toEqual([{ id: 1 }]);
    await session.close();
  });

  test("a question answered reaches the model; an unanswered one times out into the no-operator answer", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "q1", name: "ask_human", input: { text: "Which env?" } }]),
      textRound("ok"),
      toolRound([{ id: "q2", name: "ask_human", input: { text: "Sure?" } }]),
      textRound("ok"),
    );
    const session = await createAgentSession(nodeOptions());

    const answered = reader(session.send("deploy"));
    const [question] = eventsOf(await answered.until("question"), "question");
    expect(session.answer(question?.requestId ?? "", { text: "staging" })).toBe("accepted");
    await answered.rest();
    expect(provider.requests[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool-result", toolCallId: "q1", content: "staging" }),
    );

    const unanswered = reader(session.send("again"));
    await unanswered.until("question");
    timers.fire(APPROVAL_MS);
    await unanswered.rest();
    const last = provider.requests[3]?.messages.findLast((message) => message.role === "tool-result");
    expect(last).toMatchObject({ isError: true });
    expect(JSON.stringify(last)).toContain("No human operator");
    await session.close();
  });
});

describe("agent session on Node: cancellation and teardown", () => {
  test("cancel during a tool ends the turn cancelled and aborts the tool's signal", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const seen: EmbedderToolContext[] = [];
    const session = await createAgentSession(nodeOptions({ tools: [stuckTool(seen)] }));
    const events = reader(session.send("go"));
    await events.until("tool_call");
    await tick();
    session.cancel("person pressed stop");
    expect(turnEndOf(await events.rest()).status).toBe("cancelled");
    expect(seen[0]?.signal.aborted).toBe(true);
    await session.close();
  });

  test("breaking out of the iterator cancels the turn and frees the session", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const session = await createAgentSession(nodeOptions({ tools: [stuckTool([])] }));
    for await (const event of session.send("first")) {
      if (event.type === "tool_call") break;
    }
    await untilSettled(session, undefined);
    expect(session.lastTurn?.status).toBe("cancelled");
    provider.push(textRound("ok"));
    expect(turnEndOf(await collect(session.send("second"))).status).toBe("completed");
    await session.close();
  });

  test("close during a turn delivers turn_end(cancelled) and keeps the document", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const options = nodeOptions({ tools: [stuckTool([])] });
    const session = await createAgentSession(options);
    const events = reader(session.send("go"));
    await events.until("tool_call");
    const closing = session.close();
    expect(turnEndOf(await events.rest()).status).toBe("cancelled");
    await closing;
    expect(await options.transcriptStore.load(session.id)).not.toBeNull();
  });
});

describe("agent session on Node: profiles", () => {
  test("none advertises the scratchpad trio, embedder tools and ask_human; read adds the read tools", async () => {
    const provider = installScriptedProvider();
    provider.push(textRound("a"), textRound("b"));
    const none = await createAgentSession(nodeOptions({ tools: [lookupTool("never", [])] }));
    await collect(none.send("hi"));
    expect(provider.requests[0]?.tools?.map((tool) => tool.name).sort()).toEqual(
      ["ScratchpadList", "ScratchpadRead", "ScratchpadWrite", "ask_human", "lookup"].sort(),
    );
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-node-read-"));
    try {
      const read = await createAgentSession(nodeOptions({ profile: "read", workdir }));
      await collect(read.send("hi"));
      expect(provider.requests[1]?.tools?.map((tool) => tool.name).sort()).toEqual(
        ["Git", "Glob", "Grep", "Read", "ScratchpadList", "ScratchpadRead", "ScratchpadWrite", "ask_human"].sort(),
      );
      await read.close();
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
    await none.close();
  });
});
