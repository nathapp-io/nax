/**
 * S3-4: interactive behaviour through a live session (spec 4.2, 4.3, 4.4,
 * 6.1): an embedder tool approved, denied and timed out; a question answered
 * and timed out; cancel during a tool and during an approval; breaking out of
 * the iterator; close during a turn; and the stalled-consumer cap.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, type EmbedderTool, type EmbedderToolContext } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import {
  collect,
  eventsOf,
  installManualTimers,
  installScriptedProvider,
  reader,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
  types,
  untilSettled,
} from "#test/helpers/agent-session";
import { assertNaxError, stubSessionSandboxDeps, withDepsRestore, withSessionSandboxSeam } from "#test/helpers/index";

const APPROVAL_MS = 600_000;

afterEach(resetScriptedProvider);

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
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

/** An embedder tool that ignores its signal and never settles: the facade must abandon it. */
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

describe("agent session: approvals", () => {
  withDepsRestore(_agentSessionDeps);

  test("an always-approval tool asks with its call id, runs on allow, and the turn completes", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: { id: 42 } }]), textRound("found it"));
    const runs: unknown[] = [];
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", runs)] }));
    const events = reader(session.send("find 42"));
    const upTo = await events.until("approval_requested");
    expect(types(upTo).slice(-2)).toEqual(["tool_call", "approval_requested"]);
    const [request] = eventsOf(upTo, "approval_requested");
    expect(request).toMatchObject({ callId: "c1", tool: "lookup", summary: '{"id":42}' });
    expect(runs).toHaveLength(0);
    expectCode(() => session.answer(request?.requestId ?? "", { text: "yes" }), "AGENT_SESSION_INVALID_ANSWER");
    expect(session.answer(request?.requestId ?? "", { decision: "allow" })).toBe("accepted");
    const rest = await events.rest();
    expect(eventsOf(rest, "approval_resolved")[0]).toMatchObject({ decision: "allow", decidedBy: "human" });
    expect(eventsOf(rest, "tool_result")[0]).toMatchObject({ callId: "c1", isError: false, preview: "record 42" });
    expect(turnEndOf(rest)).toMatchObject({ status: "completed", output: "found it" });
    expect(runs).toEqual([{ id: 42 }]);
    await session.close();
  });

  test("a denial reaches the model as a refusal and the tool does not run", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: { id: 1 } }]), textRound("ok"));
    const runs: unknown[] = [];
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", runs)] }));
    const events = reader(session.send("find 1"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    session.answer(request?.requestId ?? "", { decision: "deny" });
    const rest = await events.rest();
    expect(eventsOf(rest, "tool_result")[0]?.preview).toContain("Denied");
    expect(runs).toHaveLength(0);
    expect(turnEndOf(rest).status).toBe("completed");
    await session.close();
  });

  test("an unanswered approval times out as a denial; a later answer is expired", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: {} }]), textRound("ok"));
    const runs: unknown[] = [];
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", runs)] }));
    const events = reader(session.send("find"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(timers.fire(APPROVAL_MS)).toBe(1);
    const rest = await events.rest();
    expect(eventsOf(rest, "approval_resolved")[0]).toMatchObject({ decision: "deny", decidedBy: "timeout" });
    expect(session.answer(request?.requestId ?? "", { decision: "allow" })).toBe("expired");
    expect(runs).toHaveLength(0);
    await session.close();
  });
});

describe("agent session: built-in approvals under full + gated", () => {
  withDepsRestore(_agentSessionDeps);
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  test("a Bash command is put to the person with its call id and a masked command; a denial does not run it", async () => {
    installManualTimers();
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no sandbox in unit tests" });
    const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "b1", name: "Bash", input: { command: `git push https://${token}@github.com/o/r` } }]),
      textRound("ok"),
    );
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-session-full-"));
    const session = await createAgentSession(sessionOptions({ profile: "full", workdir, allowUnsandboxed: true }));
    const events = reader(session.send("push it"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(request).toMatchObject({ callId: "b1", tool: "Bash" });
    expect(request?.command).toContain("git push");
    expect(JSON.stringify(request)).not.toContain(token);
    session.answer(request?.requestId ?? "", { decision: "deny" });
    const rest = await events.rest();
    expect(eventsOf(rest, "tool_result")[0]?.preview).toContain("Denied");
    expect(turnEndOf(rest).status).toBe("completed");
    await session.close();
  });
});

describe("agent session: questions", () => {
  withDepsRestore(_agentSessionDeps);

  test("ask_human raises a question; the answer is the tool result the model sees", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "q1", name: "ask_human", input: { text: "Which env?" } }]), textRound("ok"));
    const session = await createAgentSession(sessionOptions());
    const events = reader(session.send("deploy"));
    const [question] = eventsOf(await events.until("question"), "question");
    expect(question?.text).toBe("Which env?");
    expect(session.answer(question?.requestId ?? "", { text: "staging" })).toBe("accepted");
    expect(turnEndOf(await events.rest()).status).toBe("completed");
    expect(provider.requests[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool-result", toolCallId: "q1", content: "staging" }),
    );
    await session.close();
  });

  test("an unanswered question times out into the loop's no-operator answer", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "q1", name: "ask_human", input: { text: "?" } }]), textRound("ok"));
    const session = await createAgentSession(sessionOptions());
    const events = reader(session.send("deploy"));
    await events.until("question");
    timers.fire(APPROVAL_MS);
    await events.rest();
    const toolResult = provider.requests[1]?.messages.find((message) => message.role === "tool-result");
    expect(toolResult).toMatchObject({ isError: true });
    expect(JSON.stringify(toolResult)).toContain("No human operator");
    await session.close();
  });
});

describe("agent session: cancellation and teardown", () => {
  withDepsRestore(_agentSessionDeps);

  test("cancel during a tool that ignores its signal abandons it, ends the turn cancelled, and frees the session", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const seen: EmbedderToolContext[] = [];
    const session = await createAgentSession(sessionOptions({ tools: [stuckTool(seen)] }));
    const events = reader(session.send("go"));
    await events.until("tool_call");
    await tick();
    session.cancel("person pressed stop");
    const rest = await events.rest();
    expect(eventsOf(rest, "tool_result")[0]).toMatchObject({ callId: "c1", isError: true });
    expect(turnEndOf(rest).status).toBe("cancelled");
    expect(seen[0]?.signal.aborted).toBe(true);
    provider.push(textRound("next"));
    expect(turnEndOf(await collect(session.send("again"))).status).toBe("completed");
    await session.close();
  });

  test("cancel during an approval resolves it as cancelled; answering it then says cancelled", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: {} }]));
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", [])] }));
    const events = reader(session.send("go"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    session.cancel();
    const rest = await events.rest();
    expect(eventsOf(rest, "approval_resolved")[0]).toMatchObject({ decision: "deny", decidedBy: "cancelled" });
    expect(turnEndOf(rest).status).toBe("cancelled");
    expect(session.answer(request?.requestId ?? "", { decision: "allow" })).toBe("cancelled");
    await session.close();
  });

  test("breaking out of the iterator cancels; send is busy until the turn drains; history keeps the message", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const store = createMemoryTranscriptStore();
    const session = await createAgentSession(sessionOptions({ transcriptStore: store, tools: [stuckTool([])] }));
    for await (const event of session.send("first")) {
      if (event.type === "tool_call") break;
    }
    expectCode(() => session.send("too soon"), "AGENT_SESSION_BUSY");
    await untilSettled(session, undefined);
    expect(session.lastTurn?.status).toBe("cancelled");
    provider.push(textRound("ok"));
    expect(turnEndOf(await collect(session.send("second"))).status).toBe("completed");
    expect((await store.load(session.id))?.messages[0]).toEqual({ role: "user", content: "first" });
    await session.close();
  });

  test("close during a turn delivers turn_end(cancelled), keeps the document, then refuses send", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "wait", input: {} }]));
    const store = createMemoryTranscriptStore();
    const session = await createAgentSession(sessionOptions({ transcriptStore: store, tools: [stuckTool([])] }));
    const events = reader(session.send("go"));
    await events.until("tool_call");
    const closing = session.close();
    expect(turnEndOf(await events.rest()).status).toBe("cancelled");
    await closing;
    expect(await store.load(session.id)).not.toBeNull();
    expectCode(() => session.send("again"), "AGENT_SESSION_CLOSED");
  });

  test("the turn deadline ends a turn waiting on a question as timed_out", async () => {
    const timers = installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "q1", name: "ask_human", input: { text: "?" } }]));
    const session = await createAgentSession(sessionOptions({ turnTimeoutSeconds: 120 }));
    const events = reader(session.send("deploy"));
    await events.until("question");
    expect(timers.fire(120_000)).toBe(1);
    expect(turnEndOf(await events.rest()).status).toBe("timed_out");
    await session.close();
  });

  test("a consumer that stops reading is cut off at the control-event cap", async () => {
    installManualTimers();
    _agentSessionDeps.controlEventCap = 2;
    const provider = installScriptedProvider();
    provider.push(
      toolRound([
        { id: "a", name: "lookup", input: {} },
        { id: "b", name: "lookup", input: {} },
      ]),
      textRound("done"),
    );
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("never", [])] }));
    const events = reader(session.send("go"));
    await events.until("turn_start");
    await untilSettled(session, undefined);
    const end = turnEndOf(await events.rest());
    expect(end.status).toBe("errored");
    expect(end.error?.code).toBe("AGENT_SESSION_CONSUMER_STALLED");
    await session.close();
  });
});

describe("agent session: answer statuses", () => {
  withDepsRestore(_agentSessionDeps);

  test("an answer to a request the session never issued is refused while the session is open", async () => {
    installManualTimers();
    installScriptedProvider();
    const session = await createAgentSession(sessionOptions());
    expectCode(() => session.answer("no-such-id", { decision: "allow" }), "AGENT_SESSION_INVALID_ANSWER");
    await session.close();
  });

  test("every answer after close is unknown, including one close itself cancelled", async () => {
    installManualTimers();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "c1", name: "lookup", input: {} }]));
    const session = await createAgentSession(sessionOptions({ tools: [lookupTool("always", [])] }));
    const events = reader(session.send("go"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    const closing = session.close();
    await events.rest();
    await closing;
    expect(session.answer(request?.requestId ?? "", { decision: "allow" })).toBe("unknown");
    expect(session.answer("no-such-id", { decision: "allow" })).toBe("unknown");
    await session.close();
  });
});
