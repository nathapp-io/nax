/**
 * runRectification — flags actually reach runPhase's context-stage override (nax#1737
 * Phase B2).
 *
 * Two things this proves that the phase-stage-map and run-phase unit tests cannot:
 *
 * 1. The fix-op dispatch (`wrappedCallOp`, rectification.ts's `runFixCycle` `callOp`
 *    option) passes `inRectification: true` through to `runPhase`, so a fix-cycle
 *    `implementer` op requests the `rectify` context-engine stage bundle instead of
 *    `tdd-implementer` — even when the plan is three-session.
 * 2. The revalidation sweep (`cycle.validate`) forwards `isThreeSession` from
 *    `RectificationOverrides` (previously silently dropped, defaulting to `false`),
 *    so a three-session run's revalidation `verifier` phase requests `tdd-verifier`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeTestRuntime } from "@test/helpers";
import { _storyOrchestratorDeps, runRectification } from "@/execution";
import type { FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";
import type { CallContext, Operation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { mockFullSuiteGateOp, mockImplementerOp, mockVerifierOp } from "../_revalidation-fixtures";

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let runtime: NaxRuntime;

function makeCtx(assembleStageBundle: CallContext["assembleStageBundle"]): CallContext {
  runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-1737b2",
    assembleStageBundle,
  } as CallContext;
}

function makeRectifyState(): Parameters<typeof runRectification>[1] {
  return {
    fullSuiteGate: { kind: "full-suite-gate", slot: { op: mockFullSuiteGateOp, input: { story: "US-1737b2" } } },
    verifier: { kind: "verifier", slot: { op: mockVerifierOp, input: { story: "US-1737b2" } } },
    rectification: { maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false },
  };
}

const SEED_FINDING: Finding = {
  source: "test-runner",
  severity: "error",
  category: "",
  message: "seed finding",
};

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  await runtime?.close();
});

describe("runRectification threads inRectification + isThreeSession into runPhase (nax#1737 Phase B2)", () => {
  test("fix-op dispatch requests the rectify stage for implementer, even on a three-session plan", async () => {
    const requestedStages: string[] = [];
    const ctx = makeCtx(async (stage: string) => {
      requestedStages.push(stage);
      return undefined;
    });
    _storyOrchestratorDeps.callOp = mock(async () => ({
      success: true,
      passed: true,
      findings: [],
    })) as typeof _storyOrchestratorDeps.callOp;

    let capturedCallOp: (<I, O, C>(cc: FixCycleContext, op: Operation<I, O, C>, input: I) => Promise<O>) | undefined;
    _storyOrchestratorDeps.runFixCycle = mock(
      async (
        _cycle: FixCycle<Finding>,
        cycleCtx: FixCycleContext,
        _label: string,
        options?: { callOp?: typeof capturedCallOp },
      ) => {
        capturedCallOp = options?.callOp;
        // Exercise the fix-op dispatch directly, mirroring what runFixCycle's own
        // strategy-execution loop would do.
        await capturedCallOp?.(cycleCtx, mockImplementerOp, { story: "US-1737b2" });
        return { iterations: [], finalFindings: [], exitReason: "resolved" as FixCycleExitReason, costUsd: 0 };
      },
    ) as typeof _storyOrchestratorDeps.runFixCycle;

    await runRectification(
      ctx,
      makeRectifyState(),
      {},
      {},
      {
        initialFindings: [SEED_FINDING],
        isThreeSession: true,
      },
    );

    assertDefined(capturedCallOp, "capturedCallOp");
    expect(requestedStages).toContain("rectify");
    expect(requestedStages).not.toContain("tdd-implementer");
  });

  test("revalidation sweep requests tdd-verifier for the verifier phase on a three-session plan", async () => {
    const requestedStages: string[] = [];
    const ctx = makeCtx(async (stage: string) => {
      requestedStages.push(stage);
      return undefined;
    });
    _storyOrchestratorDeps.callOp = mock(async () => ({
      success: true,
      passed: true,
      findings: [],
    })) as typeof _storyOrchestratorDeps.callOp;

    let capturedCycle: FixCycle<Finding> | undefined;
    let capturedCycleCtx: FixCycleContext | undefined;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>, cycleCtx: FixCycleContext) => {
      capturedCycle = cycle;
      capturedCycleCtx = cycleCtx;
      return { iterations: [], finalFindings: [], exitReason: "resolved" as FixCycleExitReason, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;

    await runRectification(
      ctx,
      makeRectifyState(),
      {},
      {},
      {
        initialFindings: [SEED_FINDING],
        isThreeSession: true,
      },
    );

    assertDefined(capturedCycle, "capturedCycle");
    assertDefined(capturedCycleCtx, "capturedCycleCtx");
    await capturedCycle.validate(capturedCycleCtx, { mode: "full", strategiesRun: ["full-suite-rectify"] });

    expect(requestedStages).toContain("tdd-verifier");
  });
});
