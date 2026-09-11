/**
 * US-003 — "Skip rectification validation after zero dispatch" (rectification phase).
 *
 * AC3 — with `abortOnNoProgress: true` and `consecutiveNoProgressToBail: 3`, three
 * consecutive zero-dispatch dispatches must not reach the no-progress bail. A
 * zero-dispatch iteration is evidence of nothing — no hop of the operation ever
 * reached a model — so it must not be charged against the budget whose whole
 * purpose is to test whether progress is still possible.
 *
 * Driven through `runRectification` (the production entry point) with the fix
 * dispatch stubbed to raise `CALL_OP_NO_DISPATCH`, the way `callOp` reports an
 * operation whose hops never reached a model (US-001). The phase runs with the
 * story-scoped fix budget enabled, so consecutive passes chain their iterations
 * through the run-scoped store — the production path on which zero-dispatch
 * iterations actually accumulate (`storyScopedFixBudget`, rectification re-entry).
 *
 * The cycle-level counterpart of these tests lives in
 * test/unit/findings/cycle-no-dispatch.test.ts.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeMockAgentManager, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { pickSelector } from "@/config";
import { NaxError } from "@/errors";
import { _storyOrchestratorDeps, runRectification } from "@/execution";
import type { Finding, FixStrategy } from "@/findings";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const testSel = pickSelector("test-rect-no-dispatch-sel", "execution");
type TestSelConfig = ReturnType<typeof testSel.select>;

const FIX_OP_NAME = "nd-fix-op";
const STORY_ID = "US-003-rect-no-dispatch";
const AGENT = "claude";

/** The blocking gate finding the rectification pass exists to fix. */
const ND_FINDING: Finding = {
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "gate finding the fix never gets to touch",
  file: "test/nd.test.ts",
};

const ndGateOp: DeterministicOperation<unknown, unknown, TestSelConfig> = {
  kind: "deterministic",
  name: "full-suite-gate",
  stage: "verify",
  config: testSel,
  execute: async () => ({ success: false, findings: [ND_FINDING], normalizedFindings: [ND_FINDING] }),
};

const ndFixOp: RunOperation<{ story: string }, { applied: boolean }, TestSelConfig> = {
  kind: "run",
  name: FIX_OP_NAME,
  stage: "rectification",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "Fix", overridable: false },
    task: { id: "t", content: "Fix the findings", overridable: false },
  }),
  parse: () => ({ applied: true }),
};

function ndStrategy(maxAttempts: number): FixStrategy<Finding, { story: string }, { applied: boolean }> {
  return {
    name: "nd-fix-strategy",
    appliesTo: (f) => f.source === "test-runner",
    fixOp: ndFixOp,
    buildInput: () => ({ story: STORY_ID }),
    maxAttempts,
    coRun: "exclusive",
  };
}

/**
 * Minimal state satisfying `collectRectificationPhases` (the gate) and carrying
 * the no-progress policy under test.
 */
function ndState(maxAttempts: number): Parameters<typeof runRectification>[1] {
  return {
    fullSuiteGate: { kind: "full-suite-gate", slot: { op: ndGateOp, input: {} } },
    rectification: {
      maxAttempts: 20,
      strategies: [ndStrategy(maxAttempts)],
      abortOnIncreasingFailures: false,
      abortOnNoProgress: true,
      consecutiveNoProgressToBail: 3,
    },
  };
}

/** The gate is already red in `phaseOutputs`, so the cycle is seeded from it. */
function ndSeedPhaseOutputs(): Record<string, unknown> {
  return {
    "full-suite-gate": { success: false, findings: [ND_FINDING], normalizedFindings: [ND_FINDING] },
  };
}

function ndRuntime(): NaxRuntime {
  return makeTestRuntime({
    // The story-scoped fix budget is what carries this pass's iterations into the
    // next one — the production path on which the budget accumulates.
    config: makeNaxConfig({ execution: { rectification: { storyScopedFixBudget: true } } }),
    agentManager: makeMockAgentManager(),
  });
}

function ndCtx(runtime: NaxRuntime): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: AGENT,
    storyId: STORY_ID,
  };
}

/** `phaseOutputs.rectification.exitReason` — what the phase reported for the pass. */
function readExitReason(phaseOutputs: Record<string, unknown>): string | undefined {
  const rectification = phaseOutputs.rectification;
  if (typeof rectification !== "object" || rectification === null) return undefined;
  const reason = (rectification as { exitReason?: unknown }).exitReason;
  return typeof reason === "string" ? reason : undefined;
}

/** The zero-dispatch error `callOp` raises for an operation whose hops never reached a model (US-001). */
function zeroDispatchError(): NaxError {
  return new NaxError(`callOp[${FIX_OP_NAME}]: no dispatch completed`, "CALL_OP_NO_DISPATCH", {
    stage: "rectification",
    storyId: STORY_ID,
    agentName: AGENT,
  });
}

/**
 * Stub the fix dispatch at the `callOp` seam: the gate answers, the fix operation
 * raises `CALL_OP_NO_DISPATCH`. Returns the number of fix dispatches attempted, so
 * a test can assert the phase kept trying instead of bailing out before dispatching.
 */
function stubFixDispatch(dispatch: "zero-dispatch" | "completed"): { attempted: () => number; restore: () => void } {
  const original = _storyOrchestratorDeps.callOp;
  let attempted = 0;
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { kind?: string; name: string }) => {
    if (op.kind === "deterministic") {
      return { success: false, findings: [ND_FINDING], normalizedFindings: [ND_FINDING], estimatedCostUsd: 0 };
    }
    if (op.name === FIX_OP_NAME) {
      attempted += 1;
      if (dispatch === "zero-dispatch") throw zeroDispatchError();
      return { applied: false };
    }
    return { success: true };
  }) as typeof _storyOrchestratorDeps.callOp;
  return {
    attempted: () => attempted,
    restore: () => {
      _storyOrchestratorDeps.callOp = original;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — zero-dispatch iterations are excluded from the no-progress budget
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC3 — zero-dispatch dispatches do not reach the no-progress bail", () => {
  test("AC3: three consecutive zero-dispatch dispatches do not reach the no-progress bail", async () => {
    const runtime = ndRuntime();
    const stub = stubFixDispatch("zero-dispatch");
    const exitReasons: Array<string | undefined> = [];
    try {
      const ctx = ndCtx(runtime);
      const phaseOutputs = ndSeedPhaseOutputs();
      // Four passes. Passes 1-3 are the three consecutive zero-dispatch iterations
      // (each skips validation and is excluded from the budget); pass 4 is the one
      // whose iteration-start bail check would fire if any of them had been charged.
      for (let pass = 0; pass < 4; pass++) {
        const before = stub.attempted();
        let thrown: unknown;
        try {
          await runRectification(ctx, ndState(12), {}, phaseOutputs, { skipGateTriage: true });
        } catch (err) {
          thrown = err;
        }
        // A zero-dispatch dispatch is a phase outcome, not a thrown error.
        expect(thrown).toBeUndefined();
        expect(stub.attempted()).toBe(before + 1);
        exitReasons.push(readExitReason(phaseOutputs));
      }
    } finally {
      stub.restore();
      await runtime.close();
    }

    // The bail budget was never reached, despite `consecutiveNoProgressToBail: 3`
    // and three zero-dispatch iterations piling up in the story's fix history.
    expect(exitReasons).not.toContain("bail-when");
    // Pass 1 reported the zero-dispatch condition, and no pass reported a value
    // that hides it behind a bail or a false resolve.
    expect(exitReasons[0]).toBe("no-dispatch");
    expect(exitReasons).not.toContain("resolved");
  });

  test("AC3 boundary: the same config still bails on three completed no-progress iterations", async () => {
    // The exclusion must be specific to zero-dispatch iterations. A completed
    // dispatch that resolved nothing is real evidence about progress, so the
    // budget it feeds must still fire — the fix must not defang the bail.
    const runtime = ndRuntime();
    const stub = stubFixDispatch("completed");
    try {
      const ctx = ndCtx(runtime);
      const phaseOutputs = ndSeedPhaseOutputs();

      await runRectification(ctx, ndState(12), {}, phaseOutputs, { skipGateTriage: true });

      // Three completed fixes, then the fourth iteration's bail check fires
      // before it dispatches anything.
      expect(stub.attempted()).toBe(3);
      expect(readExitReason(phaseOutputs)).toBe("bail-when");
    } finally {
      stub.restore();
      await runtime.close();
    }
  });
});
