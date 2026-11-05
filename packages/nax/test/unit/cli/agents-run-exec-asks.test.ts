/**
 * US-004: the asks an unattended run answers itself, and the `--timeout` and cancellation that
 * outrank whatever the turn reported.
 *
 * Every test enters through `runAgentTask` with `_agentsRunExecDeps.runSubagent` stubbed, so no
 * session is opened and no agent runs. The timer tests drive `_agentsRunExecDeps.setTimeout` and
 * `clearTimeout` from `makeFakeClock`, so none of them waits on the real clock.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, ToolProvider } from "@nathapp/nax-agent";
import {
  approvalRequestedEvent,
  type FakeClock,
  makeAgentResource,
  makeFakeClock,
  makeNaxConfig,
  makeScriptedSession,
  questionEvent,
  type ScriptedSession,
  withDepsRestore,
} from "@test/helpers";
import {
  _agentsRunExecDeps,
  AGENTS_RUN_MAX_TIMER_DELAY_MS,
  AGENTS_RUN_NO_ANSWER,
  type AgentsRunTaskInput,
  runAgentTask,
} from "@/cli/agents-run-exec";

type RunSubagentInput = Parameters<typeof _agentsRunExecDeps.runSubagent>[0];
type RunSubagentResult = Awaited<ReturnType<typeof _agentsRunExecDeps.runSubagent>>;
type TurnEnd = Extract<SessionEvent, { type: "turn_end" }>;
type SessionHooks = Parameters<typeof makeScriptedSession>[2];

const AT = "2026-10-01T00:00:00.000Z";
const EVENT_BASE = { sessionId: "nested-1", turnId: "turn-1", at: AT, metadata: {} };
const MODEL = "anthropic/claude-sonnet";

const agent = makeAgentResource({ name: "spec-reviewer" });

function provider(id: string): ToolProvider {
  return { id, kind: "static", stages: ["*"], tools: async () => [] };
}

/** A turn_end carrying the fields these tests do not vary. */
function turnEnd(overrides: Partial<TurnEnd> & Pick<TurnEnd, "status">): TurnEnd {
  return {
    ...EVENT_BASE,
    type: "turn_end",
    output: "",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0,
    ...overrides,
  };
}

function input(overrides: Partial<AgentsRunTaskInput> = {}): AgentsRunTaskInput {
  return {
    agent,
    task: "review the spec",
    model: MODEL,
    allowedTools: ["Read", "Grep"],
    toolProviders: [provider("nax-workflow")],
    loopHandlers: [],
    cwd: "/repo/packages/nax",
    repoRoot: "/repo",
    config: makeNaxConfig(),
    ...overrides,
  };
}

/** An agent session that records every `answer`; the run under test never sends a turn on it. */
async function* noTurn(): AsyncGenerator<SessionEvent> {}

function fakeSession(hooks: SessionHooks = {}): ScriptedSession {
  return makeScriptedSession("nested-1", noTurn, hooks);
}

interface FakeTimers {
  readonly clock: FakeClock;
  /** How many timers the run armed through `_agentsRunExecDeps.setTimeout`. */
  armed(): number;
}

/** Drive the run's `--timeout` timer from a virtual clock, so no test waits on a real one. */
function useFakeTimers(): FakeTimers {
  const clock = makeFakeClock();
  let arms = 0;
  _agentsRunExecDeps.setTimeout = (callback, delayMs) => {
    arms++;
    return clock.setTimeout(callback, delayMs);
  };
  _agentsRunExecDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
  return { clock, armed: () => arms };
}

/** Resolve once `signal` aborts: the run's own timeout and the caller's signal both land here. */
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return Promise.reject(new Error("the run gave the nested session no signal"));
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** The one `runSubagent` call every test makes, and the input it received. */
interface ScriptedRun {
  readonly calls: RunSubagentInput[];
}

function stubRun(script: (request: RunSubagentInput) => Promise<RunSubagentResult>): ScriptedRun {
  const calls: RunSubagentInput[] = [];
  _agentsRunExecDeps.runSubagent = async (request) => {
    calls.push(request);
    return script(request);
  };
  return { calls };
}

interface WaitsForAbortOptions {
  /** The `turn_end` the stub emits once the nested signal aborts; none when the turn never ended. */
  readonly status?: TurnEnd["status"];
  /** Called once the stub is waiting on the abort, so a test knows the run is settled in flight. */
  readonly onListening?: () => void;
}

/** A stub that holds the turn open until the nested signal aborts, then reports what the turn said. */
function waitsForAbort(options: WaitsForAbortOptions = {}): (request: RunSubagentInput) => Promise<RunSubagentResult> {
  return async (request) => {
    // Registered synchronously, so the caller may abort as soon as `onListening` fires.
    const aborted = whenAborted(request.signal);
    options.onListening?.();
    await aborted;
    if (options.status !== undefined) request.onEvent(turnEnd({ status: options.status }));
    return { isError: true, content: "subagent spec-reviewer cancelled: cancelled" };
  };
}

/** Open the session on the stub, emit one ask on it, then finish the turn. */
function askThenFinish(
  session: ScriptedSession,
  ask: SessionEvent,
): (request: RunSubagentInput) => Promise<RunSubagentResult> {
  return async (request) => {
    request.onSession?.(session);
    request.onEvent(ask);
    return { content: "done" };
  };
}

describe("runAgentTask asks", () => {
  withDepsRestore(_agentsRunExecDeps);

  test("AC-1: answers an answerable approval_requested with a denial", async () => {
    const session = fakeSession();
    const ask = approvalRequestedEvent("r1", "recursive delete", { tool: "Bash", summary: "rm -rf build" });
    stubRun(askThenFinish(session, ask));

    await runAgentTask(input());

    expect(session.answers).toEqual([["r1", { decision: "deny" }]]);
  });

  test("AC-2: records the denied approval in deniedAsks", async () => {
    const session = fakeSession();
    const ask = approvalRequestedEvent("r1", "recursive delete", { tool: "Bash", summary: "rm -rf build" });
    stubRun(askThenFinish(session, ask));

    const result = await runAgentTask(input());

    expect(result.deniedAsks).toEqual([{ kind: "approval", tool: "Bash", summary: "rm -rf build" }]);
  });

  test("AC-3: answers an answerable question with the no-answer text", async () => {
    const session = fakeSession();
    stubRun(askThenFinish(session, questionEvent("q1", "Which file?")));

    await runAgentTask(input());

    expect(session.answers).toEqual([["q1", { text: AGENTS_RUN_NO_ANSWER }]]);
  });

  test("AC-4: records the unanswered question in deniedAsks", async () => {
    const session = fakeSession();
    stubRun(askThenFinish(session, questionEvent("q1", "Which file?")));

    const result = await runAgentTask(input());

    expect(result.deniedAsks).toEqual([{ kind: "question", text: "Which file?" }]);
  });

  test("AC-5: AGENTS_RUN_NO_ANSWER is the text an unattended question is answered with", () => {
    expect(AGENTS_RUN_NO_ANSWER).toBe(
      "No one is attached to answer. Continue without an answer, or stop and say what you need.",
    );
  });

  test("AC-6: an ask the profile already decided is neither answered nor recorded", async () => {
    const session = fakeSession();
    const ask = approvalRequestedEvent("r1", "the review profile denies writes", {
      tool: "Bash",
      summary: "rm -rf build",
      answerable: false,
    });
    stubRun(askThenFinish(session, ask));

    const result = await runAgentTask(input());

    expect(session.answers).toEqual([]);
    expect(result.deniedAsks).toEqual([]);
  });

  test("AC-7: two answerable asks are recorded in the order they arrived", async () => {
    const session = fakeSession();
    stubRun(async (request) => {
      request.onSession?.(session);
      request.onEvent(approvalRequestedEvent("r1", "recursive delete", { tool: "Bash", summary: "rm -rf build" }));
      request.onEvent(approvalRequestedEvent("r2", "write outside the diff", { tool: "Write", summary: "write a.ts" }));
      return { content: "done" };
    });

    const result = await runAgentTask(input());

    expect(result.deniedAsks).toEqual([
      { kind: "approval", tool: "Bash", summary: "rm -rf build" },
      { kind: "approval", tool: "Write", summary: "write a.ts" },
    ]);
  });

  test("AC-8: an ask the session expired is still recorded", async () => {
    const session = fakeSession({ answer: () => "expired" });
    const ask = approvalRequestedEvent("r1", "recursive delete", { tool: "Bash", summary: "rm -rf build" });
    stubRun(askThenFinish(session, ask));

    const result = await runAgentTask(input());

    expect(session.answers).toEqual([["r1", { decision: "deny" }]]);
    expect(result.deniedAsks).toEqual([{ kind: "approval", tool: "Bash", summary: "rm -rf build" }]);
  });

  test("AC-9: an answer that throws is swallowed, and the ask is still recorded", async () => {
    const session = fakeSession({
      answer: () => {
        throw new Error("the session closed underneath the ask");
      },
    });
    stubRun(async (request) => {
      request.onSession?.(session);
      request.onEvent(approvalRequestedEvent("r1", "recursive delete", { tool: "Bash", summary: "rm -rf build" }));
      request.onEvent(turnEnd({ status: "completed" }));
      return { content: "done" };
    });

    const result = await runAgentTask(input());

    expect(result.status).toBe("completed");
    expect(result.deniedAsks).toEqual([{ kind: "approval", tool: "Bash", summary: "rm -rf build" }]);
  });
});

describe("runAgentTask timeout", () => {
  withDepsRestore(_agentsRunExecDeps);

  test("AC-10: the run's own timeout aborts the signal the nested session is given", async () => {
    const timers = useFakeTimers();
    const script = stubRun(waitsForAbort());

    const run = runAgentTask(input({ timeoutSeconds: 30 }));
    await timers.clock.advance(30_000);
    await run;

    expect(script.calls[0]?.signal?.aborted).toBe(true);
  });

  test("AC-11: a turn that ends cancelled after the timeout still reports timeout", async () => {
    const timers = useFakeTimers();
    stubRun(waitsForAbort({ status: "cancelled" }));

    const run = runAgentTask(input({ timeoutSeconds: 30 }));
    await timers.clock.advance(30_000);

    expect((await run).status).toBe("timeout");
  });

  test("AC-12: a turn that ends completed after the timeout still reports timeout", async () => {
    const timers = useFakeTimers();
    stubRun(waitsForAbort({ status: "completed" }));

    const run = runAgentTask(input({ timeoutSeconds: 30 }));
    await timers.clock.advance(30_000);

    expect((await run).status).toBe("timeout");
  });

  test("AC-13: a timeout before the turn began reports timeout, not failed", async () => {
    const timers = useFakeTimers();
    stubRun(waitsForAbort());

    const run = runAgentTask(input({ timeoutSeconds: 30 }));
    await timers.clock.advance(30_000);

    expect((await run).status).toBe("timeout");
  });

  test("AC-14: a run that finishes first leaves no timer armed", async () => {
    const timers = useFakeTimers();
    stubRun(async (request) => {
      request.onEvent(turnEnd({ status: "completed" }));
      return { content: "done" };
    });

    const result = await runAgentTask(input({ timeoutSeconds: 30 }));

    expect(result.status).toBe("completed");
    expect(timers.armed()).toBe(1);
    expect(timers.clock.pending()).toBe(0);
  });

  test("AC-15: without --timeout no timer is armed at all", async () => {
    const timers = useFakeTimers();
    stubRun(async () => ({ content: "done" }));

    await runAgentTask(input());

    expect(timers.armed()).toBe(0);
  });

  test.each([
    { seconds: 30, delayMs: 30_000 },
    { seconds: 3_600, delayMs: 3_600_000 },
    { seconds: 86_400, delayMs: 86_400_000 },
    // Just under the limit a runtime timer can represent: armed exactly as asked.
    { seconds: 2_147_483, delayMs: 2_147_483_000 },
    // 2_147_484 s is 2_147_484_000 ms, past the 2_147_483_647 ms a runtime timer can hold.
    { seconds: 2_147_484, delayMs: AGENTS_RUN_MAX_TIMER_DELAY_MS },
    { seconds: 100_000_000, delayMs: AGENTS_RUN_MAX_TIMER_DELAY_MS },
  ])("F1: --timeout $seconds s is armed as a delay the runtime can represent", async ({ seconds, delayMs }) => {
    const delays: number[] = [];
    _agentsRunExecDeps.setTimeout = (_callback, armedDelayMs) => {
      delays.push(armedDelayMs);
      return 0;
    };
    stubRun(async () => ({ content: "done" }));

    await runAgentTask(input({ timeoutSeconds: seconds }));

    expect(delays).toEqual([delayMs]);
    expect(delayMs).toBeLessThanOrEqual(AGENTS_RUN_MAX_TIMER_DELAY_MS);
  });
});

describe("runAgentTask cancellation", () => {
  withDepsRestore(_agentsRunExecDeps);

  test("AC-16: aborting the caller's signal aborts the signal the nested session is given", async () => {
    const caller = new AbortController();
    const listening = Promise.withResolvers<void>();
    const script = stubRun(waitsForAbort({ onListening: () => listening.resolve() }));

    const run = runAgentTask(input({ signal: caller.signal }));
    await listening.promise;
    caller.abort();
    await run;

    expect(script.calls[0]?.signal?.aborted).toBe(true);
  });

  test("AC-17: a turn that ends cancelled after the signal still reports cancelled", async () => {
    const caller = new AbortController();
    const listening = Promise.withResolvers<void>();
    stubRun(waitsForAbort({ status: "cancelled", onListening: () => listening.resolve() }));

    const run = runAgentTask(input({ signal: caller.signal }));
    await listening.promise;
    caller.abort();

    expect((await run).status).toBe("cancelled");
  });

  test("AC-18: a turn that ends completed after the signal still reports cancelled", async () => {
    const caller = new AbortController();
    const listening = Promise.withResolvers<void>();
    stubRun(waitsForAbort({ status: "completed", onListening: () => listening.resolve() }));

    const run = runAgentTask(input({ signal: caller.signal }));
    await listening.promise;
    caller.abort();

    expect((await run).status).toBe("cancelled");
  });

  test("AC-19: an already aborted signal reports cancelled even without a turn_end", async () => {
    const caller = new AbortController();
    caller.abort();
    stubRun(async () => ({ isError: true, content: "subagent a cancelled: cancelled" }));

    const result = await runAgentTask(input({ signal: caller.signal }));

    expect(result.status).toBe("cancelled");
  });

  test("AC-20: a timeout outranks a signal that arrives before the turn ends", async () => {
    const timers = useFakeTimers();
    const caller = new AbortController();
    // The turn resumes only once the test lets it, so the signal lands before the turn ends.
    const resumed = Promise.withResolvers<void>();
    stubRun(async (request) => {
      await whenAborted(request.signal);
      await resumed.promise;
      request.onEvent(turnEnd({ status: "cancelled" }));
      return { isError: true, content: "subagent spec-reviewer cancelled: cancelled" };
    });

    const run = runAgentTask(input({ timeoutSeconds: 30, signal: caller.signal }));
    await timers.clock.advance(30_000);
    caller.abort();
    resumed.resolve();

    expect((await run).status).toBe("timeout");
  });
});

describe("runAgentTask result", () => {
  withDepsRestore(_agentsRunExecDeps);

  test("AC-21: a completed priced turn with no asks resolves the whole result", async () => {
    const script = stubRun(async (request) => {
      request.onEvent(turnEnd({ status: "completed", costUsd: 0.42, costSource: "computed" }));
      return { content: "done" };
    });

    expect(await runAgentTask(input())).toEqual({
      agent: agent.qualifiedName,
      model: MODEL,
      status: "completed",
      output: "done",
      deniedAsks: [],
      costUsd: 0.42,
    });
    expect(script.calls.length).toBe(1);
  });
});
