/**
 * B2 (whole-branch review, US-004): the run's `--timeout` and its caller's signal must reach
 * session CREATION, not only the turn.
 *
 * Every test enters through `runAgentTask` with the real `runSubagent` and the real option
 * builders behind it; only `createAgentSession` is stubbed, with an open that stays pending
 * until its `openSignal` aborts — the shape of a slow or stuck ACP startup. Before the fix the
 * options carried no `openSignal`, so that open could never settle: the run outlived its own
 * timer and ignored SIGINT/SIGTERM. The assertions are on what the command reports (`timeout`,
 * `cancelled`, never `failed`) and on the fact that nothing is left armed or dangling.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSession, CreateAgentSessionOptions } from "@nathapp/nax-agent";
import { makeAgentResource, makeFakeClock, makeNaxConfig, withDepsRestore } from "@test/helpers";
import { _subagentSessionDeps } from "@/chat/subagent-session";
import { _agentsRunExecDeps, type AgentsRunResult, type AgentsRunTaskInput, runAgentTask } from "@/cli/agents-run-exec";

const ACP_MODEL = "acp:codex/gpt-6.1-terra";
const NATIVE_MODEL = "anthropic/claude-sonnet";
const OPEN_FAILURE = "[chat] subagent spec-reviewer failed: open cancelled";

/** The two transports `runSubagent` picks between; each builds its own options. */
const TRANSPORTS: [string, string][] = [
  ["ACP", ACP_MODEL],
  ["native", NATIVE_MODEL],
];

const agent = makeAgentResource({ name: "spec-reviewer", tools: ["Read"] });

function input(overrides: Partial<AgentsRunTaskInput> = {}): AgentsRunTaskInput {
  return {
    agent,
    task: "review the spec",
    model: ACP_MODEL,
    toolProviders: [],
    loopHandlers: [],
    cwd: "/repo/packages/nax",
    repoRoot: "/repo",
    config: makeNaxConfig(),
    ...overrides,
  };
}

/** Drive the run's `--timeout` timer from a virtual clock, so no test waits on a real one. */
function useFakeTimers() {
  const clock = makeFakeClock();
  _agentsRunExecDeps.setTimeout = (callback, delayMs) => clock.setTimeout(callback, delayMs);
  _agentsRunExecDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
  return clock;
}

interface PendingOpen {
  /** Resolves once `createAgentSession` was entered — that is, once the open is in flight. */
  readonly entered: Promise<void>;
  readonly openSignals: (AbortSignal | undefined)[];
}

/**
 * Stub session creation with an open that never finishes on its own: it settles only when the
 * `openSignal` it was given aborts. An open given no signal is reported rather than left
 * pending, so a missing `openSignal` fails the test instead of hanging it.
 */
function stubPendingOpen(): PendingOpen {
  const started = Promise.withResolvers<void>();
  const openSignals: (AbortSignal | undefined)[] = [];
  _subagentSessionDeps.createAgentSession = async (options: CreateAgentSessionOptions) => {
    const signal = options.openSignal;
    openSignals.push(signal);
    started.resolve();
    if (signal === undefined) throw new Error("the run gave session creation no openSignal");
    return await new Promise<AgentSession>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("open cancelled")), { once: true });
    });
  };
  return { entered: started.promise, openSignals };
}

/** The real rule-set resolver would walk the filesystem; rules play no part in this test. */
function stubRuleSet(): void {
  _subagentSessionDeps.resolveRuleSet = async () => ({
    rules: [],
    repoRulesTotal: 0,
    repoRulesMatchedPaths: 0,
    packageRulesCount: 0,
  });
}

describe("agents run: the run's limits reach session creation", () => {
  withDepsRestore(_subagentSessionDeps);
  withDepsRestore(_agentsRunExecDeps);

  test.each(TRANSPORTS)("B2: the --timeout aborts a stuck %s open and reports timeout", async (_transport, model) => {
    const clock = useFakeTimers();
    stubRuleSet();
    const open = stubPendingOpen();

    const running = runAgentTask(input({ model, timeoutSeconds: 30 }));
    await open.entered;
    await clock.advance(30_000);
    const result: AgentsRunResult = await running;

    expect(result.status).toBe("timeout");
    expect(result.output).toBe(OPEN_FAILURE);
    expect(open.openSignals).toHaveLength(1);
    expect(open.openSignals[0]?.aborted).toBe(true);
    expect(result.deniedAsks).toEqual([]);
    expect(result).not.toHaveProperty("costUsd");
    // The run cancelled its own timer; nothing is left armed.
    expect(clock.pending()).toBe(0);
  });

  test("B2: a signal that arrives while the ACP session is opening reports cancelled", async () => {
    const clock = useFakeTimers();
    const open = stubPendingOpen();
    const controller = new AbortController();

    const running = runAgentTask(input({ signal: controller.signal }));
    await open.entered;
    controller.abort();
    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(result.output).toBe(OPEN_FAILURE);
    // The open is bounded by the run's own controller, which the caller's signal aborts —
    // creation must never be handed the caller's signal itself.
    expect(open.openSignals[0]).not.toBe(controller.signal);
    expect(open.openSignals[0]?.aborted).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  test("B2: a signal that arrives while the native session is opening reports cancelled", async () => {
    useFakeTimers();
    stubRuleSet();
    const open = stubPendingOpen();
    const controller = new AbortController();

    const running = runAgentTask(input({ model: NATIVE_MODEL, signal: controller.signal }));
    await open.entered;
    controller.abort();
    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(result.output).toBe(OPEN_FAILURE);
    expect(open.openSignals[0]?.aborted).toBe(true);
  });
});
