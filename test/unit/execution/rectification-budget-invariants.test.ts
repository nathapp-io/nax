/**
 * US-005b — Preserve rectification and fail-open invariants.
 *
 * The shared (storyId, tier) budget introduced by US-003/004 must not contaminate
 * the indicators that AC1–AC4 of the README depend on. This file proves the
 * boundaries:
 *
 *   AC1 — non-blocking-fix (nbf) override path opts out of the shared budget.
 *   AC2 — non-blocking-fix invocation does NOT consume the blocking budget
 *         (subsequent blocking runRectification still dispatches the full cap).
 *   AC3 — `countOscillationOutcomes` reads only this cycle's iterations, not
 *         the prior store, so a carry-in does not inflate the per-story
 *         oscillation total. The shared fixKey is read for the budget alone.
 *   AC4 — the phase cycle output's `iterationCount` is this cycle's iteration
 *         count, not the store's accumulated total.
 *   AC5 — exhaustion on one (storyId, tier) does not bleed to a different
 *         storyId under the same runtime.
 *   AC6 — `runtime.storyFixHistory` absent (plugin-supplied partial runtime)
 *         fails open: per-cycle behaviour, no throw.
 *   AC7 — `phaseTelemetry` absent (no tier) → subsequent invocation dispatches
 *         0 fixes (first exhausted the budget keyed on
 *         `${storyId}::default`).
 *   AC8 — `ctx.storyId` absent → no state recorded in `storyFixHistory`.
 *
 * Tests drive `runRectification` directly for every AC (the same call pattern
 * `ExecutionPlan.run` produces internally). External I/O (callOp) is mocked
 * via `_storyOrchestratorDeps` so no real agent processes are spawned.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, pickSelector } from "@/config";
import { _storyOrchestratorDeps, runRectification } from "@/execution";
import type { DeterministicOperation, InternalBuildState } from "@/execution";
import { getStoryFixState, storyFixKey } from "@/findings";
import type { Finding, FixStrategy, Iteration } from "@/findings";
import type { CallContext, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager, makeNaxConfig, makeTestRuntime } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
//
// Mirrors `story-scoped-fix-budget.test.ts` exactly: a `DeterministicOperation`
// for the gate (so the cycle's validate call routes through `callOp` and the
// mock sees `op.kind === "deterministic"`), a `RunOperation` for the fix-op,
// and a counter that increments on every fix-op invocation. The dispatch count
// is the load-bearing observable in every AC.
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-us005b-sel", "execution");

const NR_FIXOP_NAME = "nr-fixop";

const GATE_FINDING: Finding = {
  source: "full-suite-gate",
  severity: "error",
  category: "failed-test",
  message: "gate finding",
  file: "test/us005b.test.ts",
};

const nrGateOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
  kind: "deterministic",
  name: "full-suite-gate",
  stage: "verify",
  config: testSel as never,
  execute: async () => ({ success: false, findings: [GATE_FINDING], normalizedFindings: [GATE_FINDING], estimatedCostUsd: 0 }),
};

const nrFixOp: RunOperation<{ story: string }, { applied: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: NR_FIXOP_NAME,
  stage: "rectification",
  config: testSel as never,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "Fix", overridable: false },
    task: { id: "t", content: "Fix the findings", overridable: false },
  }),
  parse: () => ({ applied: true }),
};

function nrStrategy(maxAttempts: number): FixStrategy<Finding, { story: string }, { applied: boolean }> {
  return {
    name: "nr-fix-strategy",
    appliesTo: (f) => f.source === "full-suite-gate",
    fixOp: nrFixOp,
    buildInput: () => ({ story: "S" }),
    maxAttempts,
    coRun: "exclusive",
  };
}

function nrState(maxAttempts: number): InternalBuildState {
  return {
    fullSuiteGate: { kind: "full-suite-gate", slot: { op: nrGateOp, input: {} } },
    rectification: {
      maxAttempts: 20,
      strategies: [nrStrategy(maxAttempts) as unknown as FixStrategy<Finding, unknown, unknown, unknown>],
      abortOnIncreasingFailures: false,
      abortOnNoProgress: false,
    },
  } as InternalBuildState;
}

function nrSeedPhaseOutputs(): Record<string, unknown> {
  return {
    "full-suite-gate": { success: false, findings: [GATE_FINDING], normalizedFindings: [GATE_FINDING] },
  };
}

function nrCtx(
  runtime: NaxRuntime,
  storyId: string | undefined,
  tier?: string,
): CallContext {
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

function makeBudgetRuntime(storyScopedFixBudget: boolean): NaxRuntime {
  const config = makeNaxConfig({
    execution: { rectification: { storyScopedFixBudget } },
  } as never);
  return makeTestRuntime({ config, agentManager: makeMockAgentManager() });
}

const createdRuntimes: NaxRuntime[] = [];

function track(rt: NaxRuntime): NaxRuntime {
  createdRuntimes.push(rt);
  return rt;
}

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.splice(0).map((r) => r.close()));
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam: counts fix-op dispatches. The mocked callOp MUST keep the gate failing
// so the cycle keeps iterating until the per-strategy cap is reached. Mirrors
// the gating in `story-scoped-fix-budget.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

interface NrRunOptions {
  storyId: string | undefined;
  tier?: string;
  maxAttempts?: number;
  /** When provided, stop the gate after this many deterministic calls so the cycle exits early. */
  resolveAfterCalls?: number;
  overrides?: Record<string, unknown>;
}

interface NrRunResult {
  dispatchCount: number;
  phaseOutputs: Record<string, unknown>;
  result: unknown;
}

async function nrRun(
  runtime: NaxRuntime,
  opts: NrRunOptions,
): Promise<NrRunResult> {
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
      return { success: false, findings: [GATE_FINDING], normalizedFindings: [GATE_FINDING], estimatedCostUsd: 0 };
    }
    if (op.name === NR_FIXOP_NAME) {
      dispatchCount++;
      return { applied: true };
    }
    return { success: true };
  }) as typeof _storyOrchestratorDeps.callOp;

  try {
    const ctx = nrCtx(runtime, storyId, tier);
    const phaseOutputs = nrSeedPhaseOutputs();
    const result = await runRectification(ctx, nrState(maxAttempts), {}, phaseOutputs, {
      skipGateTriage: true,
      ...overrides,
    } as never);
    return { dispatchCount, phaseOutputs, result };
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — non-blocking-fix (nbf) path opts out of storyFixHistory entirely.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-005b AC1: nbf runRectification does not record state in storyFixHistory", () => {
  test("AC1: runRectification with initialFindings (nbf path) records no state in storyFixHistory for the story", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-1-nbf";

    await nrRun(runtime, {
      storyId,
      tier: "fast",
      overrides: { initialFindings: [GATE_FINDING] },
    });

    // AC1 requires NO state recorded for the story — not just an absence
    // under the specific (storyId, "fast") key. A faulty non-blocking path
    // could still record state for the story under another tier or the
    // default key while a single-key assertion passed. Scan every key the
    // storyFixHistory could plausibly hold for this storyId.
    const keysForStory = Array.from(runtime.storyFixHistory.keys()).filter((k) =>
      k.startsWith(`${storyId}::`),
    );
    expect(keysForStory).toEqual([]);
    expect(runtime.storyFixHistory.size).toBe(0);
  });

  test("AC1 boundary: a blocking runRectification (no initialFindings) DOES record state for the same story", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-1-blocking";
    const key = storyFixKey(storyId, "fast");

    await nrRun(runtime, { storyId, tier: "fast" });

    // The opposite control: a blocking runRectification writes to the store.
    // If a wiring regression collided the nbf opt-out with the blocking path,
    // this assertion would no longer hold. Assert on content, not presence —
    // getStoryFixState inserts an empty entry on read, so `.has(key)` alone
    // would pass even if the write path were deleted entirely.
    expect(getStoryFixState(runtime.storyFixHistory, key).iterations.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — a non-blocking-fix invocation does not consume the blocking budget.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-005b AC2: nbf invocation does not consume the blocking budget", () => {
  test("AC2: nbf then blocking runRectification dispatches the full per-strategy cap on the blocking run", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-2";

    // First: nbf pass with initialFindings. AC1 already proves it does not
    // touch the store; this test adds the AC2 corollary that the blocking
    // budget is therefore unaffected.
    await nrRun(runtime, {
      storyId,
      tier: "fast",
      maxAttempts: 3,
      overrides: { initialFindings: [GATE_FINDING] },
    });

    // Second: blocking runRectification for the same story/tier. The
    // budget is fresh, so it dispatches the full 3-attempt cap.
    const second = await nrRun(runtime, { storyId, tier: "fast", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(3);
  });

  test("AC2 boundary: with no nbf prior, the blocking run alone exhausts after 3 dispatches and the next call dispatches 0", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-2b";

    const first = await nrRun(runtime, { storyId, tier: "fast", maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);

    const second = await nrRun(runtime, { storyId, tier: "fast", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — carry-in does not inflate the per-cycle oscillation count.
// ─────────────────────────────────────────────────────────────────────────────

/** Build one iteration from before/after source lists. */
function iterFromSources(n: number, before: Finding["source"][], after: Finding["source"][]): Iteration {
  const f = (source: Finding["source"]): Finding => ({
    source,
    severity: "error",
    category: "test",
    message: source,
  });
  return {
    iterationNum: n,
    findingsBefore: before.map(f),
    fixesApplied: [],
    findingsAfter: after.map(f),
    outcome: "partial",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
  };
}

/**
 * Drives `runFixCycle` with a pre-built iteration list. Used for AC3 and AC4
 * where the test cares about the iteration shape, not the actual cycle.
 */
async function nrRunWithStaticIterations(
  runtime: NaxRuntime,
  opts: {
    storyId: string;
    tier?: string;
    iterations: Iteration[];
    exitReason?:
      | "resolved"
      | "no-strategy"
      | "max-attempts-total"
      | "max-attempts-per-strategy"
      | "validate-short-circuit"
      | "validator-error"
      | "bail-when"
      | "agent-gave-up";
    overrides?: Record<string, unknown>;
  },
): Promise<{ phaseOutputs: Record<string, unknown>; result: unknown }> {
  const { storyId, tier, iterations, exitReason = "max-attempts-total", overrides } = opts;
  const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  _storyOrchestratorDeps.runFixCycle = mock(async () => ({
    iterations,
    finalFindings: iterations.length > 0 ? [GATE_FINDING] : [],
    exitReason,
    costUsd: 0,
  })) as typeof _storyOrchestratorDeps.runFixCycle;

  try {
    const ctx = nrCtx(runtime, storyId, tier);
    const phaseOutputs = nrSeedPhaseOutputs();
    const result = await runRectification(ctx, nrState(3), {}, phaseOutputs, {
      skipGateTriage: true,
      ...overrides,
    } as never);
    return { phaseOutputs, result };
  } finally {
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
  }
}

/**
 * A two-iteration sequence: first iteration resolves a gate source, second
 * iteration brings it back. That is exactly one source-reappearance reversal.
 */
function oneReversalIters(): Iteration[] {
  return [
    iterFromSources(1, ["full-suite-gate"], ["semantic-review"]),
    iterFromSources(2, ["semantic-review"], ["full-suite-gate"]),
  ];
}

/** Forward-only sequence — no source ever reappears. Counts zero. */
function monotonicForwardIters(): Iteration[] {
  return [
    iterFromSources(1, ["full-suite-gate"], ["semantic-review"]),
    iterFromSources(2, ["semantic-review"], ["semantic-review"]),
  ];
}

describe("US-005b AC3: carry-in does not contaminate per-cycle oscillation count", () => {
  test("AC3: first cycle reverses once, second cycle has no reversal → rectificationOscillations total is 1", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-3";

    // First cycle: one reversal.
    await nrRunWithStaticIterations(runtime, {
      storyId,
      tier: "fast",
      iterations: oneReversalIters(),
      exitReason: "max-attempts-total",
    });
    expect(runtime.rectificationOscillations.get(storyId) ?? 0).toBe(1);

    // Second cycle: forward-only, no reversal. The count remains the prior
    // total — it does NOT include the second cycle's zero (proves the
    // counter is the run-level accumulator, the increment is per-cycle).
    await nrRunWithStaticIterations(runtime, {
      storyId,
      tier: "fast",
      iterations: monotonicForwardIters(),
      exitReason: "resolved",
    });
    expect(runtime.rectificationOscillations.get(storyId) ?? 0).toBe(1);
  });

  test("AC3 boundary: a single cycle with the second-cycle reversal pattern alone records 1, not 0", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-3b";

    await nrRunWithStaticIterations(runtime, {
      storyId,
      tier: "fast",
      iterations: oneReversalIters(),
      exitReason: "max-attempts-total",
    });

    // The oscillation counter is a per-cycle increment; the mocked cycle
    // did have one reversal this cycle, so the writer recorded 1.
    expect(runtime.rectificationOscillations.get(storyId) ?? 0).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — per-cycle phase output iterationCount is this cycle's iteration count.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-005b AC4: phase output iterationCount reports this cycle's count, not the store's accumulated total", () => {
  test("AC4: first runRectification with 2 iterations, second with 1 iteration → second phaseOutput iterationCount is 1", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-4";

    // First: 2 iterations.
    await nrRunWithStaticIterations(runtime, {
      storyId,
      tier: "fast",
      iterations: [
        iterFromSources(1, ["full-suite-gate"], ["semantic-review"]),
        iterFromSources(2, ["semantic-review"], []),
      ],
      exitReason: "resolved",
    });

    const second = await nrRunWithStaticIterations(runtime, {
      storyId,
      tier: "fast",
      iterations: [iterFromSources(1, ["full-suite-gate"], [])],
      exitReason: "resolved",
    });

    const phaseOutput = second.phaseOutputs.rectification as
      | { iterationCount: number }
      | undefined;
    expect(phaseOutput?.iterationCount).toBe(1);
  });

  test("AC4 boundary: store has accumulated length 3 after both runs, but per-cycle output stays cycle-scoped", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-4b";

    await nrRunWithStaticIterations(runtime, {
      storyId,
      tier: "fast",
      iterations: [
        iterFromSources(1, ["full-suite-gate"], ["semantic-review"]),
        iterFromSources(2, ["semantic-review"], []),
      ],
      exitReason: "resolved",
    });

    const second = await nrRunWithStaticIterations(runtime, {
      storyId,
      tier: "fast",
      iterations: [iterFromSources(1, ["full-suite-gate"], [])],
      exitReason: "resolved",
    });

    // Store accumulated across both cycles.
    const key = storyFixKey(storyId, "fast");
    expect(getStoryFixState(runtime.storyFixHistory, key).iterations).toHaveLength(3);

    // Per-cycle output remained at this cycle's count (1), not the
    // cumulative 3. Reading from the accumulated array would surface
    // 3 — that's the regression this test pins against.
    const phaseOutput = second.phaseOutputs.rectification as
      | { iterationCount: number }
      | undefined;
    expect(phaseOutput?.iterationCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — cross-story isolation: one story's exhaustion does not affect another.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-005b AC5: cross-story isolation — one story's exhausted budget does not consume another's", () => {
  test("AC5: US-001 exhausts, US-002 dispatches normally", async () => {
    const runtime = track(makeBudgetRuntime(true));

    const first = await nrRun(runtime, { storyId: "US-001", tier: "fast", maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);

    const second = await nrRun(runtime, { storyId: "US-002", tier: "fast", maxAttempts: 3 });
    // Fresh budget for the different story.
    expect(second.dispatchCount).toBe(3);
  });

  test("AC5 boundary: a second invocation for the SAME story on the same tier still dispatches 0 (exhaustion is per-key)", async () => {
    const runtime = track(makeBudgetRuntime(true));

    const first = await nrRun(runtime, { storyId: "US-001", tier: "fast", maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);

    const second = await nrRun(runtime, { storyId: "US-001", tier: "fast", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — runtime.storyFixHistory absent (partial / plugin-supplied runtime).
// ─────────────────────────────────────────────────────────────────────────────

describe("US-005b AC6: absent runtime.storyFixHistory fails open to per-cycle behaviour", () => {
  test("AC6: runRectification completes without throwing and dispatches fix operations under per-cycle behavior", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-6";

    // Strip the property the runtime would normally expose.
    Object.defineProperty(runtime, "storyFixHistory", {
      value: undefined,
      configurable: true,
    });

    let dispatchCount = 0;
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { kind: string; name: string }) => {
      if (op.kind === "deterministic") {
        // Gate keeps failing — cycle iterates until the per-strategy cap (3).
        return { success: false, findings: [GATE_FINDING], normalizedFindings: [GATE_FINDING], estimatedCostUsd: 0 };
      }
      if (op.name === NR_FIXOP_NAME) {
        dispatchCount++;
        return { applied: true };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    try {
      const ctx = nrCtx(runtime, storyId, "fast");
      const phaseOutputs = nrSeedPhaseOutputs();
      // Must complete without throwing — fail-open.
      await expect(
        runRectification(ctx, nrState(3), {}, phaseOutputs, { skipGateTriage: true } as never),
      ).resolves.toBeDefined();
      // Must dispatch fix operations under per-cycle behavior — the runtime
      // cannot record exhaustion (the store is absent), so the cycle starts
      // fresh. With the gate always failing and per-strategy cap=3, the cycle
      // must dispatch exactly 3 fixes before hitting the cap. A no-op
      // implementation (or one that silently skipped dispatch when the store
      // was missing) would surface as dispatchCount=0.
      expect(dispatchCount).toBe(3);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });

  test("AC6 boundary: absent runtime dispatches the full per-strategy cap on each of two back-to-back calls (per-cycle, no shared exhaustion)", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-6b";

    Object.defineProperty(runtime, "storyFixHistory", {
      value: undefined,
      configurable: true,
    });

    let dispatchCount = 0;
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { kind: string; name: string }) => {
      if (op.kind === "deterministic") {
        return { success: false, findings: [GATE_FINDING], normalizedFindings: [GATE_FINDING], estimatedCostUsd: 0 };
      }
      if (op.name === NR_FIXOP_NAME) {
        dispatchCount++;
        return { applied: true };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    try {
      const ctx = nrCtx(runtime, storyId, "fast");
      const phaseOutputs = nrSeedPhaseOutputs();

      // Two back-to-back calls — both must complete cleanly AND each must
      // dispatch the full per-strategy cap. A regression that treated the
      // absent store as "exhausted" would surface here as a 0 dispatch on
      // the second call.
      await expect(
        runRectification(ctx, nrState(3), {}, phaseOutputs, { skipGateTriage: true } as never),
      ).resolves.toBeDefined();
      const afterFirst = dispatchCount;
      await expect(
        runRectification(ctx, nrState(3), {}, phaseOutputs, { skipGateTriage: true } as never),
      ).resolves.toBeDefined();
      const afterSecond = dispatchCount;

      // Each call dispatches the full cap (3). Per-cycle semantics means
      // exhaustion does not bleed across calls.
      expect(afterFirst).toBe(3);
      expect(afterSecond).toBe(6);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — phaseTelemetry absent (no tier) → subsequent invocation dispatches 0 fixes.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-005b AC7: phaseTelemetry absent → no tier key → budget keyed on 'default'", () => {
  test("AC7: with no phaseTelemetry, the second invocation dispatches no fix operation after the first exhausts the cap", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-7";

    const first = await nrRun(runtime, { storyId, maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);

    const second = await nrRun(runtime, { storyId, maxAttempts: 3 });
    expect(second.dispatchCount).toBe(0);
  });

  test("AC7 boundary: phaseTelemetry absent does write to the 'default' key (visible via getStoryFixState)", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-7b";

    await nrRun(runtime, { storyId, maxAttempts: 3 });

    // Default key — proves the write happened under the canonical 'default'
    // segment when no tier is supplied.
    const key = storyFixKey(storyId); // tier=undefined → "default"
    const state = getStoryFixState(runtime.storyFixHistory, key);
    expect(state.iterations.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — ctx.storyId absent → no state recorded in storyFixHistory.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-005b AC8: ctx.storyId absent → no state recorded in storyFixHistory", () => {
  test("AC8: runRectification with undefined storyId leaves storyFixHistory empty", async () => {
    const runtime = track(makeBudgetRuntime(true));

    await nrRun(runtime, { storyId: undefined, tier: "fast", maxAttempts: 3 });

    expect(runtime.storyFixHistory.size).toBe(0);
  });

  test("AC8 boundary: a storyId present DOES record a state, confirming the guard skipped only on absent", async () => {
    const runtime = track(makeBudgetRuntime(true));
    const storyId = "US-005b-8b";

    await nrRun(runtime, { storyId, tier: "fast", maxAttempts: 3 });

    expect(runtime.storyFixHistory.size).toBe(1);
    expect(runtime.storyFixHistory.has(storyFixKey(storyId, "fast"))).toBe(true);
  });
});
