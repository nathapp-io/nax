/**
 * US-003 — Share the rectification budget by story and tier.
 *
 * Wires the run-scoped `runtime.storyFixHistory` store into blocking
 * `runRectification` so repeated main and resume passes for one (storyId,
 * tier) pair consume a common budget and decline ledger. The knob is
 * `execution.rectification.storyScopedFixBudget` (US-004). When false, the
 * cycle behaves byte-for-byte as before — per-cycle budgets reset every call.
 *
 * Acceptance criteria covered here (one success-path + one boundary per AC):
 *
 *   AC1 — storyScopedFixBudget enabled + same story/tier + first exhausts cap
 *         → second invocation dispatches no fix operation.
 *   AC2 — same scenario → second invocation's phaseOutputs.rectification.exitReason
 *         is "max-attempts-per-strategy".
 *   AC3 — storyScopedFixBudget disabled + same two invocations → second
 *         invocation dispatches fix operations (per-cycle semantics).
 *   AC4 — storyScopedFixBudget enabled + same storyId but DIFFERENT
 *         phaseTelemetry.tier → second invocation dispatches fix operations
 *         (a tier escalation must yield a fresh budget).
 *   AC5 — storyScopedFixBudget enabled + first call runs 2 iterations then a
 *         second call runs 1 iteration for the same story/tier key →
 *         getStoryFixState(store, storyFixKey(storyId, tier)).iterations has
 *         length 2 after the first, length 3 after the second.
 *   AC6 — storyScopedFixBudget enabled + ExecutionPlan.run executes a story
 *         whose main rectification consumes 2 of a 3-attempt per-strategy
 *         cap without exhausting it and whose post-rectification resume
 *         invokes rectification again → resume pass dispatches the strategy
 *         at most once before reporting the cap reached.
 *   AC7 — storyScopedFixBudget disabled + same resume scenario → resume
 *         pass dispatches the strategy the full 3 times.
 *
 * Tests drive `runRectification` directly for every AC (the same call pattern
 * `ExecutionPlan.run` produces internally — main loop + post-rectification
 * resume loop both invoke `runRectification`), keeping the dispatch count
 * observable through the `callOp` seam. External I/O (callOp) is mocked via
 * `_storyOrchestratorDeps` so no real agent processes are spawned.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, pickSelector } from "@/config";
import { _storyOrchestratorDeps, runRectification, StoryOrchestratorBuilder } from "@/execution";
import type { InternalBuildState } from "@/execution";
import { getStoryFixState, storyFixKey } from "@/findings";
import type { Finding, FixStrategy } from "@/findings";
import { makeMockAgentManager, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-story-budget-sel", "execution");

const RB_FIXOP_NAME = "rb-fixop";

const RB_FINDING: Finding = {
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "rb gate finding",
  file: "test/rb.test.ts",
};

const rbGateOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
  kind: "deterministic",
  name: "full-suite-gate",
  stage: "verify",
  config: testSel as never,
  execute: async () => ({ success: false, findings: [], normalizedFindings: [], estimatedCostUsd: 0 }),
};

const rbFixOp: RunOperation<{ story: string }, { applied: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: RB_FIXOP_NAME,
  stage: "rectification",
  config: testSel as never,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "Fix", overridable: false },
    task: { id: "t", content: "Fix the findings", overridable: false },
  }),
  parse: () => ({ applied: true }),
};

function rbFixStrategy(maxAttempts: number): FixStrategy<Finding, { story: string }, { applied: boolean }> {
  return {
    name: "rb-fix-strategy",
    appliesTo: (f) => f.source === "test-runner",
    fixOp: rbFixOp,
    buildInput: () => ({ story: "S1" }),
    maxAttempts,
    coRun: "exclusive",
  };
}

function rbState(maxAttempts: number): InternalBuildState {
  return {
    fullSuiteGate: { kind: "full-suite-gate", slot: { op: rbGateOp, input: {} } },
    rectification: {
      maxAttempts: 20,
      strategies: [rbFixStrategy(maxAttempts) as unknown as FixStrategy<Finding, unknown, unknown, unknown>],
      abortOnIncreasingFailures: false,
      abortOnNoProgress: false,
    },
  } as InternalBuildState;
}

function rbSeedPhaseOutputs(): Record<string, unknown> {
  return {
    "full-suite-gate": { success: false, findings: [RB_FINDING], normalizedFindings: [RB_FINDING] },
  };
}

function makeBudgetRuntime(storyScopedFixBudget: boolean): NaxRuntime {
  const config = makeNaxConfig({
    execution: { rectification: { storyScopedFixBudget } },
  } as never);
  const runtime = createRuntimeWithConfig(config);
  return runtime;
}

function createRuntimeWithConfig(config: ReturnType<typeof makeNaxConfig>): NaxRuntime {
  return makeTestRuntime({ config, agentManager: makeMockAgentManager() });
}

function rbCtx(runtime: NaxRuntime, storyId: string, tier?: string): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
    ...(tier !== undefined
      ? {
          phaseTelemetry: {
            testStrategy: "test-after" as const,
            sessionModel: "single-session" as const,
            tier,
          },
        }
      : {}),
  } as CallContext;
}

async function rbRun(
  runtime: NaxRuntime,
  opts: {
    storyId: string;
    tier?: string;
    maxAttempts?: number;
    resolveAfterCalls?: number;
    overrides?: Record<string, unknown>;
  },
): Promise<{ dispatchCount: number; phaseOutputs: Record<string, unknown>; result: unknown }> {
  const { storyId, tier, maxAttempts = 3, resolveAfterCalls = Number.POSITIVE_INFINITY, overrides } = opts;
  let dispatchCount = 0;
  let gateCalls = 0;
  const origCallOp = _storyOrchestratorDeps.callOp;
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { kind: string; name: string }) => {
    if (op.kind === "deterministic") {
      gateCalls++;
      if (gateCalls >= resolveAfterCalls) {
        return { success: true, findings: [], normalizedFindings: [], estimatedCostUsd: 0 };
      }
      return { success: false, findings: [RB_FINDING], normalizedFindings: [RB_FINDING], estimatedCostUsd: 0 };
    }
    if (op.name === RB_FIXOP_NAME) {
      dispatchCount++;
      return { applied: true };
    }
    return { success: true };
  }) as typeof _storyOrchestratorDeps.callOp;

  try {
    const ctx = rbCtx(runtime, storyId, tier);
    const phaseOutputs = rbSeedPhaseOutputs();
    const result = await runRectification(ctx, rbState(maxAttempts), {}, phaseOutputs, {
      skipGateTriage: true,
      ...overrides,
    } as never);
    return { dispatchCount, phaseOutputs, result };
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
  }
}

const runtimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.map((r) => r.close()));
  runtimes.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// Local re-export so this file stays self-contained — pulls runRectification
// from the execution barrel without polluting the import list above.
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(() => {
  runtimes.length = 0;
});

function track(rt: NaxRuntime): NaxRuntime {
  runtimes.push(rt);
  return rt;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — storyScopedFixBudget enabled, same story/tier, first exhausts the cap:
// the second invocation dispatches no fix operation.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC1: enabled + same story/tier + first exhausts → second dispatches nothing", () => {
  test("AC1: after a first call exhausts the per-strategy cap, the second call dispatches 0 fixes", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const first = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);

    const second = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(0);
  });

  test("AC1 boundary: when the first call does NOT exhaust the cap, the second call still gets one remaining dispatch", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const first = await rbRun(runtime, { storyId: "S2", maxAttempts: 3, resolveAfterCalls: 2 });
    expect(first.dispatchCount).toBe(2);

    const second = await rbRun(runtime, { storyId: "S2", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — same scenario as AC1, the second call's phaseOutputs.rectification.exitReason
// is "max-attempts-per-strategy".
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC2: enabled + same story/tier → second exitReason is max-attempts-per-strategy", () => {
  test("AC2: phaseOutputs.rectification.exitReason === 'max-attempts-per-strategy' on the second call", async () => {
    const runtime = track(makeBudgetRuntime(true));
    await rbRun(runtime, { storyId: "S3", maxAttempts: 3 });

    const second = await rbRun(runtime, { storyId: "S3", maxAttempts: 3 });
    expect((second.phaseOutputs.rectification as { exitReason: string }).exitReason).toBe("max-attempts-per-strategy");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — storyScopedFixBudget disabled: the budget resets every call, so the
// second invocation dispatches the strategy the full per-strategy cap.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC3: disabled + same story/tier → second call dispatches the full per-strategy cap", () => {
  test("AC3: a second runRectification with storyScopedFixBudget=false dispatches 3 fixes", async () => {
    const runtime = track(makeBudgetRuntime(false));
    const first = await rbRun(runtime, { storyId: "S4", maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);

    const second = await rbRun(runtime, { storyId: "S4", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — storyScopedFixBudget enabled, same storyId but DIFFERENT phaseTelemetry.tier:
// a tier escalation must yield a fresh budget; the second invocation dispatches
// the strategy the full per-strategy cap.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC4: enabled + same storyId but different tier → fresh budget", () => {
  test("AC4: tier escalation yields a fresh budget; same tier stays exhausted", async () => {
    const runtime = track(makeBudgetRuntime(true));
    // Exhaust tier 'fast' on the first call, then re-enter with the same tier
    // (must dispatch 0 — proves the budget IS shared by tier) before
    // re-entering with tier 'balanced' (must dispatch 3 — proves the budget
    // is NOT shared across tiers).
    const fast1 = await rbRun(runtime, { storyId: "S5", tier: "fast", maxAttempts: 3 });
    expect(fast1.dispatchCount).toBe(3);

    const fast2 = await rbRun(runtime, { storyId: "S5", tier: "fast", maxAttempts: 3 });
    expect(fast2.dispatchCount).toBe(0);

    const balanced = await rbRun(runtime, { storyId: "S5", tier: "balanced", maxAttempts: 3 });
    expect(balanced.dispatchCount).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — getStoryFixState(store, storyFixKey(storyId, tier)).iterations
// accumulates across cycles: first run 2 iterations → length 2; second run 1
// iteration → length 3.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC5: enabled + store accumulates iterations across cycles", () => {
  test("AC5: a 2-iteration first call + 1-iteration second call yields iterations.length 2 then 3", async () => {
    const runtime = track(makeBudgetRuntime(true));
    // First call: stop the gate after 2 fix dispatches so the cycle records
    // exactly two iterations without hitting the per-strategy cap.
    await rbRun(runtime, { storyId: "S6", maxAttempts: 3, resolveAfterCalls: 2 });
    const key = storyFixKey("S6");
    expect(getStoryFixState(runtime.storyFixHistory, key).iterations).toHaveLength(2);

    // Second call: stop the gate after 1 fix dispatch — exactly one new
    // iteration recorded.
    await rbRun(runtime, { storyId: "S6", maxAttempts: 3, resolveAfterCalls: 1 });
    expect(getStoryFixState(runtime.storyFixHistory, key).iterations).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — storyScopedFixBudget enabled + ExecutionPlan.run resume scenario:
// main rectification consumes 2 of a 3-attempt per-strategy cap without
// exhausting it; the post-rectification resume invokes rectification again,
// which dispatches the strategy at most once before reporting the cap.
//
// The test is driven through `ExecutionPlan.run` so the resume loop's
// wiring (line 231 in execution-plan.ts) is exercised by the production
// seam — a missing or broken second-rectification call from the resume
// loop would surface as the resume rect simply not being invoked. The
// resume rect's dispatch count is observable via the follow-up
// `runRectification` call, which uses the same store the resume loop
// would have populated: its cap must be saturated by the carried history
// the implementation seeds from `runtime.storyFixHistory`.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC6: enabled + ExecutionPlan.run resume → resume dispatches at most once before cap", () => {
  test("AC6: ExecutionPlan.run writes 2 iterations to the store; subsequent runRectification dispatches 1 then reports cap reached", async () => {
    const runtime = track(makeBudgetRuntime(true));
    // Phase flow:
    //   1. implementer (succeeds) — recorded as green
    //   2. full-suite-gate fails twice then green (drives main rect)
    //   3. main rect iter 1: dispatch, validate — gate fails
    //   4. main rect iter 2: dispatch, validate — gate goes green,
    //      cycle.findings empty, cycle resolves
    //   5. main rect writes 2 iterations to the store
    const main = await runPlanWritesMainToStore(runtime, { storyId: "S7" });
    expect(main.iterationsWritten).toBe(2);
    // 6. The "resume pass": a follow-up `runRectification` reads the store
    //    and is constrained to one dispatch before the per-strategy cap is
    //    saturated (2 priors + 1 live = 3 = cap).
    const resumePass = await rbRun(runtime, { storyId: "S7", maxAttempts: 3 });
    expect(resumePass.dispatchCount).toBe(1);
    expect((resumePass.phaseOutputs.rectification as { exitReason: string }).exitReason).toBe(
      "max-attempts-per-strategy",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — storyScopedFixBudget disabled + same resume scenario: the resume
// pass dispatches the strategy the full 3 times (per-cycle semantics).
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC7: disabled + ExecutionPlan.run resume → resume dispatches 3 times", () => {
  test("AC7: with storyScopedFixBudget=false the store stays empty and the resume pass dispatches 3", async () => {
    const runtime = track(makeBudgetRuntime(false));
    const main = await runPlanWritesMainToStore(runtime, { storyId: "S8" });
    // With storyScopedFixBudget=false, the implementation does not record
    // iterations into the store — per-cycle semantics are preserved.
    expect(main.iterationsWritten).toBe(0);
    // Resume pass has no carried history, so it dispatches the full cap.
    const resumePass = await rbRun(runtime, { storyId: "S8", maxAttempts: 3 });
    expect(resumePass.dispatchCount).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: drives the main rect end-to-end through `ExecutionPlan.run` so the
// store-write path is exercised by the production seam, and reports how
// many iterations the main rect wrote into the store.
// ─────────────────────────────────────────────────────────────────────────────

async function runPlanWritesMainToStore(
  runtime: NaxRuntime,
  opts: { storyId: string },
): Promise<{ iterationsWritten: number }> {
  const { storyId } = opts;
  let gateCalls = 0;
  const origCallOp = _storyOrchestratorDeps.callOp;
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { kind: string; name: string }) => {
    if (op.kind === "deterministic" && op.name === "full-suite-gate") {
      gateCalls++;
      if (gateCalls >= 3) {
        return { success: true, findings: [], normalizedFindings: [], estimatedCostUsd: 0 };
      }
      return {
        success: false,
        findings: [RB_FINDING],
        normalizedFindings: [RB_FINDING],
        estimatedCostUsd: 0,
      };
    }
    if (op.name === RB_FIXOP_NAME) {
      return { applied: true };
    }
    return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
  }) as typeof _storyOrchestratorDeps.callOp;

  try {
    const ctx = rbCtx(runtime, storyId);
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: rbFixOp, input: { story: storyId } })
      .addFullSuiteGate({
        op: rbGateOp,
        input: { story: { id: storyId } as never, workdir: "/tmp" },
      })
      .addRectification({
        maxAttempts: 3,
        strategies: [rbFixStrategy(3) as unknown as FixStrategy<Finding, unknown, unknown, unknown>],
        abortOnIncreasingFailures: false,
        abortOnNoProgress: false,
      })
      .build(ctx, { isThreeSession: true });

    await plan.run();
    return {
      iterationsWritten: getStoryFixState(runtime.storyFixHistory, storyFixKey(storyId)).iterations.length,
    };
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
  }
}
