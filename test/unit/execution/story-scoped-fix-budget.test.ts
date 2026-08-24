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
 *         getStoryFixState(store, storyFixKey(storyId, tier, agent)).iterations has
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

import { afterEach, describe, expect, mock, test } from "bun:test";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { StoryOrchestratorBuilder, _storyOrchestratorDeps, runRectification } from "@/execution";
import type { InternalBuildState } from "@/execution";
import { getStoryFixState, storyFixKey } from "@/findings";
import type { Finding, FixStrategy } from "@/findings";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager, makeNaxConfig, makeTestRuntime } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-story-budget-sel", "execution");

const RB_FIXOP_NAME = "rb-fixop";

/** Default agent for the test contexts; the store key includes it (#1530). */
const RB_AGENT = "claude";

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
      strategies: [rbFixStrategy(maxAttempts)],
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

function rbCtx(runtime: NaxRuntime, storyId: string, tier?: string, agentName = RB_AGENT): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName,
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
    agentName?: string;
    maxAttempts?: number;
    resolveAfterCalls?: number;
    overrides?: Record<string, unknown>;
  },
): Promise<{ dispatchCount: number; phaseOutputs: Record<string, unknown>; result: unknown }> {
  const { storyId, tier, agentName, maxAttempts = 3, resolveAfterCalls = Number.POSITIVE_INFINITY, overrides } = opts;
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
    const ctx = rbCtx(runtime, storyId, tier, agentName);
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
// #1530 — a cross-agent escalation rung that reuses a tier name.
// The ladder matches rungs by (tier, agent), so `fast/agent-a -> fast/agent-b`
// is a real escalation. Keying the budget on the tier alone handed the escalated
// agent the previous agent's exhausted counters, so it got zero fix iterations.
// ─────────────────────────────────────────────────────────────────────────────

describe("#1530: enabled + same tier but different agent → fresh budget", () => {
  test("a same-tier cross-agent escalation yields a fresh budget; the same rung stays exhausted", async () => {
    const runtime = track(makeBudgetRuntime(true));

    const first = await rbRun(runtime, { storyId: "S8", tier: "fast", agentName: "agent-a", maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);

    // Same rung — the budget IS shared, so nothing dispatches.
    const sameRung = await rbRun(runtime, { storyId: "S8", tier: "fast", agentName: "agent-a", maxAttempts: 3 });
    expect(sameRung.dispatchCount).toBe(0);

    // Next rung up the ladder: same tier name, different agent. The escalated
    // agent must get its own full cap rather than inheriting an exhausted one.
    const nextRung = await rbRun(runtime, { storyId: "S8", tier: "fast", agentName: "agent-b", maxAttempts: 3 });
    expect(nextRung.dispatchCount).toBe(3);
  });

  test("iterations accumulate per rung, not per tier", async () => {
    const runtime = track(makeBudgetRuntime(true));

    await rbRun(runtime, { storyId: "S9", tier: "fast", agentName: "agent-a", maxAttempts: 3, resolveAfterCalls: 2 });
    await rbRun(runtime, { storyId: "S9", tier: "fast", agentName: "agent-b", maxAttempts: 3, resolveAfterCalls: 1 });

    expect(getStoryFixState(runtime.storyFixHistory, storyFixKey("S9", "fast", "agent-a")).iterations).toHaveLength(2);
    expect(getStoryFixState(runtime.storyFixHistory, storyFixKey("S9", "fast", "agent-b")).iterations).toHaveLength(1);
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
    const key = storyFixKey("S6", undefined, RB_AGENT);
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
// exhausting it; the post-rectification resume invokes rectification
// again, which dispatches the strategy at most once before reporting the
// cap reached.
//
// Driven end-to-end through `ExecutionPlan.run` so the resume loop's
// wiring (`execution-plan.ts:193` resume-block entry, `:218` phase-fail
// detection, `:231` second-rectification call) is exercised by the
// production seam. A wiring regression in any of those three locations
// would surface as either (a) the store never recording the main rect's
// iterations, (b) the resume loop never being entered, or (c) the
// resume rect not firing — the `dispatchCount` assertion below would
// fall from 4 (correct) to 3 (resume rect missed) or 1 (main rect
// never dispatched).
//
// Setup that exercises both halves of the seam:
//   - Strategy is `autofix-implementer` so `phasesToRevalidate` keeps
//     `lint-check` and `full-suite-gate` but excludes `verifier`. The
//     exclusion is load-bearing: the verifier MUST NOT be called during
//     main rect's validate (else its failure would prevent cycle
//     resolution, OR its pass would land it in `phaseOutputs` as
//     passing and the resume loop would skip it — either way the
//     resume rect wouldn't fire).
//   - `lint-check` is stateful: passes on the 1st call (lands in the
//     main rect's iter-2 validate alongside the gate going green, so
//     cycle.findings becomes empty and the cycle resolves), then fails
//     on every subsequent call (so the resume rect's iter validates
//     keep the cycle iterating until the cap is reached).
//   - `verifier` always fails with a test-runner finding. It is
//     configured but excluded from main rect's validate by the
//     strategy — so it's not in `phaseOutputs` after main rect
//     resolves. The resume loop then calls it, it fails, and the
//     second `runRectification` is invoked (line 231).
//   - Gate is stateful: fails the 1st 2 calls (main loop + main rect
//     iter-1 validate), then succeeds.
//
// Phase flow inside plan.run:
//   1. implementer (always succeeds)
//   2. full-suite-gate fails x2 → main loop short-circuits
//   3. main rect iter 1: dispatch, validate (gate fails; verifier
//      excluded by strategy; lint-check NOT called because gate's
//      shortCircuit broke the validate loop). count=1.
//   4. main rect iter 2: dispatch, validate (gate goes green, then
//      lint-check 1st call passes). findings=[]. cycle resolves.
//   5. main rect writes 2 iterations to runtime.storyFixHistory.
//   6. Resume block entered (main rect did NOT exhaust).
//   7. Resume loop: gate (passing, skip), verifier (NOT in
//      phaseOutputs → run → fails) → 2nd runRectification invoked.
//   8. Resume rect reads store, prior = [iter1, iter2].
//      - enabled:  prior + 1 live dispatch = 3 = cap → exits after
//                 1 dispatch with max-attempts-per-strategy (the
//                 validate-short-circuit → max-attempts-per-strategy
//                 remap when prior iterations exist).
//      - disabled: prior = []; dispatches 3 times before cap.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC6: enabled + ExecutionPlan.run resume → resume dispatches at most once before cap", () => {
  test("AC6: plan.run main rect dispatches 2, resume rect fires via the resume loop and dispatches 1", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const result = await runPlanResumeScenario(runtime, { storyId: "S7" });
    // Implementer (1) + main rect (2) + resume rect (1) = 4 dispatches.
    // The single resume-rect dispatch saturates the carried cap (2 priors
    // + 1 live = 3) and exits max-attempts-per-strategy. A wiring
    // regression that skips the resume loop's second-rectification call
    // would surface as dispatchCount=3 here (resume rect missed).
    expect(result.dispatchCount).toBe(4);
    // The story-fix-history store received the iterations from both rects
    // — the WRITE half of story scoping. Plan.run is the only writer, so
    // this assertion directly exercises the production seam's
    // appendStoryFixIterations calls (main rect writes 2, resume rect
    // writes 1).
    expect(result.storeIterations).toBe(3);
    // The second rect's exitReason, surfaced via plan.run's final
    // phaseOutputs. When story scoping is enabled and the second rect
    // exits with validate-short-circuit after the carried cap is
    // saturated, the implementation remaps that to
    // max-attempts-per-strategy so the cap is observable.
    expect(result.rectificationExitReason).toBe("max-attempts-per-strategy");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — storyScopedFixBudget disabled + same resume scenario. The
// per-cycle semantics are preserved: the store is not consulted, so the
// resume rect's carried budget is empty and it dispatches the full
// per-strategy cap.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC7: disabled + ExecutionPlan.run resume → resume dispatches 3 times", () => {
  test("AC7: with storyScopedFixBudget=false plan.run resume rect fires via the resume loop and dispatches 3", async () => {
    const runtime = track(makeBudgetRuntime(false));
    const result = await runPlanResumeScenario(runtime, { storyId: "S8" });
    // Implementer (1) + main rect (2) + resume rect (3) = 6 dispatches.
    // Per-cycle semantics: the resume rect has no carried history, so
    // it dispatches the full per-strategy cap.
    expect(result.dispatchCount).toBe(6);
    // Per-cycle semantics: when storyScopedFixBudget=false the
    // implementation gates the appendStoryFixIterations call on the
    // knob (fixKey=undefined), so the store stays empty regardless of
    // how many cycles ran.
    expect(result.storeIterations).toBe(0);
    // The second rect exhausts in the same way as the enabled case,
    // but without the validate-short-circuit → max-attempts-per-strategy
    // remap (which requires fixState.iterations.length > 0).
    expect(result.rectificationExitReason).toBe("validate-short-circuit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end ExecutionPlan.run helper for AC6 / AC7.
//
// Builds a plan with implementer + gate + verifier + lint-check +
// rectification. The `autofix-implementer` strategy name keeps
// `lint-check` and `full-suite-gate` in the cycle's revalidation set
// but excludes `verifier` — load-bearing for the resume-rect trigger.
// `lint-check` is stateful: passes on the 1st call (the main rect's
// iter-2 validate), then fails on every subsequent call. `verifier`
// always fails with a test-runner finding shape.
//
// Returns the plan's result, total fixop dispatch count, the store's
// iteration count, and the final rectification phaseOutput's
// exitReason so callers can assert on both halves of the seam.
// ─────────────────────────────────────────────────────────────────────────────

async function runPlanResumeScenario(
  runtime: NaxRuntime,
  opts: { storyId: string },
): Promise<{
  dispatchCount: number;
  storeIterations: number;
  rectificationExitReason: string | undefined;
}> {
  const { storyId } = opts;
  let gateCalls = 0;
  let lintCalls = 0;
  let dispatchCount = 0;

  const lintOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
    kind: "deterministic",
    name: "lint-check",
    stage: "verify",
    config: testSel as never,
    // 1st call lands in the main rect's iter-2 validate (alongside the
    // gate going green) — must pass so cycle.findings becomes empty and
    // the cycle resolves. Every subsequent call must fail so the resume
    // rect's iter validates keep findings in the cycle until the cap is
    // saturated.
    execute: async () => {
      lintCalls++;
      if (lintCalls === 1) {
        return { success: true, findings: [], normalizedFindings: [], estimatedCostUsd: 0 };
      }
      return {
        success: false,
        findings: [RB_FINDING],
        normalizedFindings: [RB_FINDING],
        estimatedCostUsd: 0,
      };
    },
  };

  const verifierOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
    kind: "deterministic",
    name: "verifier",
    stage: "verify",
    config: testSel as never,
    // Always fails with a test-runner finding. The verifier is
    // configured but excluded from the `autofix-implementer`
    // strategy's revalidation set, so main rect's validate does NOT
    // call it — `phaseOutputs[verifier]` stays undefined. The resume
    // loop then calls it for the first time, it fails, and the
    // second `runRectification` is invoked.
    execute: async () => ({
      success: false,
      findings: [RB_FINDING],
      normalizedFindings: [RB_FINDING],
      estimatedCostUsd: 0,
    }),
  };

  const origCallOp = _storyOrchestratorDeps.callOp;
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { kind: string; name: string }) => {
    if (op.kind === "deterministic") {
      if (op.name === "full-suite-gate") {
        gateCalls++;
        // Fail the 1st two calls (main loop + main rect iter-1 validate),
        // succeed on the 3rd and every subsequent call.
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
      if (op.name === "lint-check") {
        return lintOp.execute({}, rbCtx(runtime, storyId));
      }
      if (op.name === "verifier") {
        return verifierOp.execute({}, rbCtx(runtime, storyId));
      }
      return { success: true, findings: [], normalizedFindings: [], estimatedCostUsd: 0 };
    }
    if (op.name === RB_FIXOP_NAME) {
      dispatchCount++;
      return { applied: true };
    }
    return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
  }) as typeof _storyOrchestratorDeps.callOp;

  try {
    const ctx = rbCtx(runtime, storyId);
    // Strategy named "autofix-implementer" — an existing key in
    // STRATEGY_TO_REVALIDATION_PHASES whose revalidation set includes
    // lint-check and full-suite-gate but excludes verifier. The
    // verifier exclusion is load-bearing: the verifier MUST NOT run
    // during main rect's validate (else it would either prevent cycle
    // resolution or end up in phaseOutputs as passing and be skipped
    // by the resume loop).
    const autofixImplementer: FixStrategy<Finding, unknown, unknown, unknown> = {
      name: "autofix-implementer",
      appliesTo: (f: Finding) => f.source === "test-runner",
      fixOp: rbFixOp,
      buildInput: () => ({ story: storyId }),
      maxAttempts: 3,
      coRun: "exclusive",
    };
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: rbFixOp, input: { story: storyId } })
      .addFullSuiteGate({
        op: rbGateOp,
        input: { story: { id: storyId } as never, workdir: "/tmp" },
      })
      .addVerifier({ op: verifierOp, input: { code: "" } })
      .addLintCheck({ op: lintOp, input: { workdir: "/tmp" } })
      .addRectification({
        maxAttempts: 3,
        strategies: [autofixImplementer],
        abortOnIncreasingFailures: false,
        abortOnNoProgress: false,
      })
      .build(ctx, { isThreeSession: true });

    const result = await plan.run();
    const rectOutput = result.phaseOutputs.rectification as { exitReason: string } | undefined;
    return {
      dispatchCount,
      storeIterations: getStoryFixState(runtime.storyFixHistory, storyFixKey(storyId, undefined, RB_AGENT)).iterations
        .length,
      rectificationExitReason: rectOutput?.exitReason,
    };
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
  }
}
