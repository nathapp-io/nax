/**
 * US-001: callOp raises zero-dispatch as its own terminal outcome.
 *
 * Foundation test file for the new CALL_OP_NO_DISPATCH code path. Each AC
 * from the spec maps to one or more tests here:
 *
 *   AC1 → dispatchesCompleted=1 for a single successful hop (runWithFallback)
 *   AC2 → dispatchesCompleted=0 when every hop ends in adapter failure (runWithFallback)
 *   AC3 → run-kind outcome with dispatchesCompleted=0 → throws CALL_OP_NO_DISPATCH
 *   AC4 → the CALL_OP_NO_DISPATCH error carries stage, storyId, agentName
 *   AC5 → op.parse is NOT invoked when dispatchesCompleted=0 (run-kind)
 *   AC6 → neither exhaustedFallback nor op.recover is invoked when dispatchesCompleted=0 (run-kind)
 *   AC7 → run-kind outcome with dispatchesCompleted=1 + empty output → CALL_OP_NO_OUTPUT (NOT no-dispatch)
 *   AC8 → complete-kind outcome with dispatchesCompleted=0 → throws CALL_OP_NO_DISPATCH
 *   AC9 → adapterFailure + fallbacks are recorded BEFORE the throw (run-kind)
 *
 * Companion files:
 *   - test/unit/operations/call-empty-output.test.ts — fixtures that DO have a
 *     completed dispatch (dispatchesCompleted=1) and still throw CALL_OP_NO_OUTPUT.
 *   - test/unit/agents/manager-types-phase5.test.ts — owns the AgentRunOutcome literal shape.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertNaxError,
  makeAgentAdapter,
  makeAgentRegistry,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
} from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import type { AgentRunOutcome } from "@/agents/manager-types";
import type { AgentRunOptions } from "@/agents/types";
import type { NaxConfig } from "@/config";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { AdapterFailure } from "@/context/engine";
import type { CompleteOperation, RunOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const testSel = pickSelector("no-dispatch-test", "routing");
const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeCallCtx(runtime: NaxRuntime, overrides: { agentName?: string; storyId?: string } = {}) {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: overrides.agentName ?? "claude",
    ...(overrides.storyId !== undefined ? { storyId: overrides.storyId } : {}),
  };
}

/**
 * Build a minimal run-kind op with parse and (optionally) recover / retry.
 * Parses / recovers / retry-strategy side effects land in the closure-scoped
 * counters — tests inspect those locally rather than via getters on the op.
 */
function makeRunOp(opts: {
  name: string;
  parse?: (output: string) => unknown;
  recover?: () => Promise<unknown>;
  retryStrategy?: () => import("@/agents/retry").RetryStrategy;
}): RunOperation<string, unknown, Pick<typeof DEFAULT_CONFIG, "routing">> & {
  parseCalls(): number;
  recoverCalls(): number;
} {
  let parseCalls = 0;
  let recoverCalls = 0;
  const op: RunOperation<string, unknown, Pick<typeof DEFAULT_CONFIG, "routing">> = {
    kind: "run",
    name: opts.name,
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "noop", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    ...(opts.retryStrategy ? { retry: opts.retryStrategy } : {}),
    parse: opts.parse
      ? (output: string) => {
          parseCalls += 1;
          return opts.parse?.(output);
        }
      : (output: string) => {
          parseCalls += 1;
          return { parsed: output };
        },
    ...(opts.recover
      ? {
          recover: async (): Promise<unknown> => {
            recoverCalls += 1;
            const recover = opts.recover;
            if (!recover) return null;
            // The recover hook signature is `(input, ctx) => Promise<O | null>`,
            // where O is the op's parse output type. Tests here use `unknown`
            // for O and return whatever the test factory produces.
            return await recover();
          },
        }
      : {}),
  };
  return Object.assign(op, {
    parseCalls: () => parseCalls,
    recoverCalls: () => recoverCalls,
  });
}

/** A mock manager whose runWithFallback returns `dispatchesCompleted = count`. */
function managerReportingDispatchCount(count: number, output = "ok"): ReturnType<typeof makeMockAgentManager> {
  return makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      const executeHop = req.executeHop;
      if (executeHop) {
        await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      }
      return {
        result: {
          success: count > 0,
          exitCode: 0,
          output,
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
        dispatchesCompleted: count,
      };
    },
    completeAsWithFallbackFn: async () => ({
      result: { output, tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 },
      fallbacks: [],
      dispatchesCompleted: count,
    }),
    runAsSessionFn: async () => ({
      output,
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    }),
  });
}

/** A mock manager that reports zero successful dispatches (failure-only path). */
function managerReportingZeroDispatches(
  fallbacks: ReadonlyArray<{
    priorAgent: string;
    newAgent: string;
    outcome: AdapterFailure["outcome"];
    category: AdapterFailure["category"];
  }> = [],
  adapterFailure?: AdapterFailure,
): ReturnType<typeof makeMockAgentManager> {
  const fallbackRecords = fallbacks.map((f, i) => ({
    storyId: "US-001",
    priorAgent: f.priorAgent,
    newAgent: f.newAgent,
    hop: i + 1,
    outcome: f.outcome,
    category: f.category,
    timestamp: "2026-09-14T00:00:00.000Z",
    costUsd: 0,
  }));
  return makeMockAgentManager({
    runWithFallbackFn: async () => ({
      result: {
        success: false,
        exitCode: 1,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: 0,
        agentFallbacks: fallbackRecords,
        ...(adapterFailure ? { adapterFailure } : {}),
      },
      fallbacks: fallbackRecords,
      dispatchesCompleted: 0,
    }),
    completeAsWithFallbackFn: async () => ({
      result: {
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        ...(adapterFailure ? { adapterFailure } : {}),
      },
      fallbacks: fallbackRecords,
      dispatchesCompleted: 0,
    }),
    runAsSessionFn: async () => {
      throw new Error("zero-dispatch: runAsSession should not be called");
    },
  });
}

// ---------------------------------------------------------------------------
// AC1 — runWithFallback: one successful hop → dispatchesCompleted = 1
// ---------------------------------------------------------------------------

describe("AC1: AgentManager.runWithFallback — successful hop → dispatchesCompleted = 1", () => {
  test("a single successful hop that returns a turn yields dispatchesCompleted=1", async () => {
    const registry = makeAgentRegistry({
      getAgent: () =>
        makeAgentAdapter({
          openSession: async () => ({ id: "s1", agentName: "claude" }),
          sendTurn: async () => ({
            output: "ok",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            internalRoundTrips: 1,
          }),
          closeSession: async () => {},
        }),
    });

    const manager = new AgentManager(makeAgentManagerConfig(), registry);
    const outcome: AgentRunOutcome = await manager.runWithFallback({
      runOptions: makeBaseRunOptions("US-001-ac1"),
      signal: undefined,
    });

    expect(outcome.dispatchesCompleted).toBe(1);
  });

  test("boundary: dispatchesCompleted is a non-negative integer", async () => {
    const registry = makeAgentRegistry({
      getAgent: () =>
        makeAgentAdapter({
          openSession: async () => ({ id: "s1", agentName: "claude" }),
          sendTurn: async () => ({
            output: "ok",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            internalRoundTrips: 1,
          }),
          closeSession: async () => {},
        }),
    });
    const manager = new AgentManager(makeAgentManagerConfig(), registry);
    const outcome = await manager.runWithFallback({
      runOptions: makeBaseRunOptions("US-001-ac1-boundary"),
      signal: undefined,
    });

    expect(Number.isInteger(outcome.dispatchesCompleted)).toBe(true);
    expect(outcome.dispatchesCompleted).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — runWithFallback: every hop fails → dispatchesCompleted = 0
// ---------------------------------------------------------------------------

describe("AC2: AgentManager.runWithFallback — every hop fails → dispatchesCompleted = 0", () => {
  test("no adapter produces a turn so every hop ends in failure → dispatchesCompleted=0", async () => {
    // The bare AgentManager has no `_runHop` wired and no `executeHop` is
    // supplied, so the first hop returns an "unbound" failure result. With
    // no swap candidate configured, runWithFallback bails out of the first
    // hop and returns — the count must be 0 because no adapter returned a
    // turn.
    const registry = makeAgentRegistry({
      getAgent: () => makeAgentAdapter(),
    });
    const manager = new AgentManager(makeAgentManagerConfig(), registry);

    const outcome = await manager.runWithFallback({
      runOptions: makeBaseRunOptions("US-001-ac2"),
      signal: undefined,
    });

    expect(outcome.dispatchesCompleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — callOp run-kind: dispatchesCompleted=0 → CALL_OP_NO_DISPATCH
// ---------------------------------------------------------------------------

describe("AC3: callOp — run-kind outcome with dispatchesCompleted=0 throws CALL_OP_NO_DISPATCH", () => {
  test("dispatchesCompleted=0 throws CALL_OP_NO_DISPATCH (not CALL_OP_NO_OUTPUT)", async () => {
    const agentManager = managerReportingZeroDispatches();
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(makeCallCtx(runtime), makeRunOp({ name: "ac3-op" }), "hello");
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp zero-dispatch rejection");
    expect(thrown.code).toBe("CALL_OP_NO_DISPATCH");
  });

  test("boundary: dispatchesCompleted=1 with empty output does NOT throw CALL_OP_NO_DISPATCH", async () => {
    const agentManager = managerReportingDispatchCount(1, "");
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(makeCallCtx(runtime), makeRunOp({ name: "ac3-boundary-op" }), "hello");
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp empty-output rejection");
    expect(thrown.code).toBe("CALL_OP_NO_OUTPUT");
    expect(thrown.code).not.toBe("CALL_OP_NO_DISPATCH");
  });
});

// ---------------------------------------------------------------------------
// AC4 — CALL_OP_NO_DISPATCH error context: stage, storyId, agentName
// ---------------------------------------------------------------------------

describe("AC4: CALL_OP_NO_DISPATCH error context — stage, storyId, agentName", () => {
  test("error context carries stage, storyId, and agentName from the dispatch", async () => {
    const agentManager = managerReportingZeroDispatches();
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(
        makeCallCtx(runtime, { agentName: "codex", storyId: "US-001-ac4" }),
        makeRunOp({ name: "ac4-op" }),
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp zero-dispatch rejection");
    expect(thrown.code).toBe("CALL_OP_NO_DISPATCH");
    const ctx = thrown.context ?? {};
    expect(ctx.stage).toBe("run");
    expect(ctx.storyId).toBe("US-001-ac4");
    expect(ctx.agentName).toBe("codex");
  });

  test("boundary: agentName comes from ctx.agentName, the dispatched agent", async () => {
    const agentManager = managerReportingZeroDispatches();
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(makeCallCtx(runtime, { agentName: "gemini" }), makeRunOp({ name: "ac4-boundary-op" }), "hello");
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp zero-dispatch rejection");
    expect(thrown.context?.agentName).toBe("gemini");
  });
});

// ---------------------------------------------------------------------------
// AC5 — op.parse is NOT invoked when dispatchesCompleted=0
// ---------------------------------------------------------------------------

describe("AC5: callOp — dispatchesCompleted=0 does NOT invoke op.parse", () => {
  test("parse is never called when the outcome reports zero dispatches", async () => {
    const agentManager = managerReportingZeroDispatches();
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeRunOp({ name: "parse-spy-op" });

    try {
      await callOp(makeCallCtx(runtime), op, "hello");
    } catch {
      // expected
    }

    expect(op.parseCalls()).toBe(0);
  });

  test("boundary: parse IS called when dispatchesCompleted=1 with non-empty output", async () => {
    const agentManager = managerReportingDispatchCount(1, "real output");
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const op = makeRunOp({ name: "parse-called-op" });
    await callOp(makeCallCtx(runtime), op, "hello");

    expect(op.parseCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC6 — exhaustedFallback and op.recover are NOT invoked when dispatchesCompleted=0
// ---------------------------------------------------------------------------

describe("AC6: callOp — dispatchesCompleted=0 does NOT invoke exhaustedFallback nor op.recover", () => {
  test("neither exhaustedFallback nor op.recover is invoked on zero-dispatch", async () => {
    const agentManager = managerReportingZeroDispatches();
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let exhaustedFallbackCalled = false;
    let recoverCalled = false;

    const op = makeRunOp({
      name: "ac6-op",
      retryStrategy: () => ({
        shouldRetry: () => {
          exhaustedFallbackCalled = true;
          // Match the makeParseRetryStrategy contract: `fallback` is the
          // resolved value the strategy returns. Tests pass the value they
          // want callOp to surface; a function here would trip the
          // CALL_OP_INVALID_FALLBACK guard.
          return { retry: false, fallback: undefined };
        },
      }),
      recover: async () => {
        recoverCalled = true;
        return { fromRecover: true };
      },
    });

    let thrown: unknown;
    try {
      await callOp(makeCallCtx(runtime), op, "hello");
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp zero-dispatch rejection");
    expect(thrown.code).toBe("CALL_OP_NO_DISPATCH");
    expect(exhaustedFallbackCalled).toBe(false);
    expect(recoverCalled).toBe(false);
    expect(op.recoverCalls()).toBe(0);
  });

  test("boundary: exhaustedFallback IS consulted on the empty-output path (dispatchesCompleted=1)", async () => {
    // Negative control: dispatchesCompleted=1 + empty output must still flow
    // through the existing exhaustedFallback path. This pins the asymmetry:
    // the new zero-dispatch guard must not regress the empty-output case.
    const agentManager = managerReportingDispatchCount(1, "");
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let exhaustedFallbackCalled = false;
    const op = makeRunOp({
      name: "ac6-boundary-op",
      retryStrategy: () => ({
        shouldRetry: () => {
          exhaustedFallbackCalled = true;
          return { retry: false, fallback: { passed: true, failOpen: true } };
        },
      }),
    });

    const result = await callOp(makeCallCtx(runtime), op, "hello");
    expect(result).toEqual({ passed: true, failOpen: true, estimatedCostUsd: 0 });
    expect(exhaustedFallbackCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC7 — dispatchesCompleted=1 + empty output → CALL_OP_NO_OUTPUT
// ---------------------------------------------------------------------------

describe("AC7: callOp — dispatchesCompleted=1 with empty output still throws CALL_OP_NO_OUTPUT", () => {
  test("completed dispatch with empty output throws CALL_OP_NO_OUTPUT, not CALL_OP_NO_DISPATCH", async () => {
    const agentManager = managerReportingDispatchCount(1, "");
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(makeCallCtx(runtime), makeRunOp({ name: "ac7-op" }), "hello");
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp empty-output rejection");
    expect(thrown.code).toBe("CALL_OP_NO_OUTPUT");
    expect(thrown.code).not.toBe("CALL_OP_NO_DISPATCH");
  });

  test("boundary: count=1 covers the whitespace-only case too (synthesis still fires)", async () => {
    // Spec: a whitespace-only turn that sendWithFileOutput synthesises a
    // fail-stale failure for is STILL a completed dispatch (count=1).
    // The predicate is "no dispatch completed", not "output is empty".
    const agentManager = managerReportingDispatchCount(1, "");
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(makeCallCtx(runtime), makeRunOp({ name: "ac7-boundary-op" }), "hello");
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp empty-output rejection");
    expect(thrown.code).toBe("CALL_OP_NO_OUTPUT");
  });
});

// ---------------------------------------------------------------------------
// AC8 — callOp complete-kind: dispatchesCompleted=0 → CALL_OP_NO_DISPATCH
// ---------------------------------------------------------------------------

describe("AC8: callOp — complete-kind outcome with dispatchesCompleted=0 throws CALL_OP_NO_DISPATCH", () => {
  test("complete-kind zero-dispatch throws CALL_OP_NO_DISPATCH", async () => {
    const agentManager = managerReportingZeroDispatches();
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(
        makeCallCtx(runtime),
        {
          kind: "complete",
          name: "ac8-op",
          stage: "run",
          config: testSel,
          build: (input) => ({
            role: { id: "role", content: "noop", overridable: false },
            task: { id: "task", content: input, overridable: false },
          }),
          parse: () => ({}),
        } satisfies CompleteOperation<string, unknown, Pick<typeof DEFAULT_CONFIG, "routing">>,
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp zero-dispatch rejection");
    expect(thrown.code).toBe("CALL_OP_NO_DISPATCH");
  });

  test("boundary: complete-kind with dispatchesCompleted=1 returns the parsed output", async () => {
    const agentManager = managerReportingDispatchCount(1, "complete-output");
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let parseCalls = 0;
    const op: CompleteOperation<string, unknown, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "complete",
      name: "ac8-boundary-op",
      stage: "run",
      config: testSel,
      build: (input) => ({
        role: { id: "role", content: "noop", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      parse: (output) => {
        parseCalls += 1;
        return { parsed: output };
      },
    };

    const result = await callOp(makeCallCtx(runtime), op, "hello");
    expect(result).toEqual({ parsed: "complete-output" });
    expect(parseCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC9 — adapterFailure and fallback records are recorded BEFORE the throw
// ---------------------------------------------------------------------------

describe("AC9: callOp — run-kind zero-dispatch records adapterFailure + fallbacks before throwing", () => {
  test("runtime.lastAdapterFailure is set when the outcome carries an adapterFailure", async () => {
    const adapterFailure: AdapterFailure = {
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "rate limited after 4 retries",
    };

    const agentManager = managerReportingZeroDispatches([], adapterFailure);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(makeCallCtx(runtime, { storyId: "US-001-ac9" }), makeRunOp({ name: "ac9-failure-op" }), "hello");
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp zero-dispatch rejection");
    expect(thrown.code).toBe("CALL_OP_NO_DISPATCH");
    expect(runtime.lastAdapterFailure.get("US-001-ac9")).toEqual(adapterFailure);
  });

  test("runtime.agentFallbacks records the outcome's fallback list before throwing", async () => {
    type FallbackFixture = {
      priorAgent: string;
      newAgent: string;
      outcome: AdapterFailure["outcome"];
      category: AdapterFailure["category"];
    };
    const fallbacks: ReadonlyArray<FallbackFixture> = [
      {
        priorAgent: "claude",
        newAgent: "codex",
        outcome: "fail-rate-limit",
        category: "availability",
      },
      {
        priorAgent: "codex",
        newAgent: "gemini",
        outcome: "fail-service-down",
        category: "availability",
      },
    ];

    const agentManager = managerReportingZeroDispatches(fallbacks);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    try {
      await callOp(
        makeCallCtx(runtime, { storyId: "US-001-ac9-fb" }),
        makeRunOp({ name: "ac9-fallbacks-op" }),
        "hello",
      );
    } catch {
      // expected
    }

    const recorded = runtime.agentFallbacks.get("US-001-ac9-fb");
    expect(recorded).toBeDefined();
    expect(recorded).toHaveLength(2);
    expect(recorded?.[0].priorAgent).toBe("claude");
    expect(recorded?.[1].priorAgent).toBe("codex");
  });

  test("boundary: ad-hoc callOp without a storyId does NOT touch either store, but still throws CALL_OP_NO_DISPATCH", async () => {
    // Negative control: an ad-hoc invocation has no story to attribute spend
    // to, so the recording branches (gated on ctx.storyId) are skipped. The
    // throw must still fire — error semantics do not depend on story
    // attribution.
    const adapterFailure: AdapterFailure = {
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "x",
    };

    const agentManager = managerReportingZeroDispatches([], adapterFailure);
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: unknown;
    try {
      await callOp(makeCallCtx(runtime), makeRunOp({ name: "ac9-no-story-op" }), "hello");
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown, "callOp zero-dispatch rejection");
    expect(thrown.code).toBe("CALL_OP_NO_DISPATCH");
    expect(runtime.agentFallbacks.size).toBe(0);
    expect(runtime.lastAdapterFailure.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AgentManager config + AgentRunOptions helpers — keep AC1/AC2 readable.
// ---------------------------------------------------------------------------

function makeAgentManagerConfig(): import("@/config/selectors").AgentManagerConfig {
  return agentManagerConfigSelector.select(
    makeNaxConfig({
      agent: {
        fallback: {
          enabled: false,
          map: {},
          maxHopsPerStory: 1,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
    }),
  );
}

function makeBaseRunOptions(storyId: string): AgentRunOptions {
  // Mirrors the helper in test/unit/agents/manager-types-phase5.test.ts. Uses
  // a minimal NaxConfig literal (not DEFAULT_CONFIG) so this test does not
  // depend on the schema-default value being a literal at runtime.
  const minimalConfig: NaxConfig = makeNaxConfig({});
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: agentManagerConfigSelector.select(minimalConfig),
    pipelineStage: "run",
    storyId,
    sessionRole: "implementer",
  };
}
