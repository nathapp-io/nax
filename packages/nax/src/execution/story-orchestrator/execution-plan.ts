import type { CallContext } from "@/operations";
import {
  hydrateResumeState,
  maybeRunNonBlockingFix,
  type PlanParams,
  runCanonicalLoop,
  runMechanicalOnlyResume,
  runPostRectificationResume,
  settleProvisionalRectification,
} from "./execution-plan-phases";
import { buildStoryOrchestratorResult } from "./execution-plan-verdict";
import { gateFailureKeys } from "./phase-eval";
import { collectOrderedPhases } from "./phase-state";
import { runRectification } from "./rectification";
import type { InternalBuildState, StoryOrchestratorResult } from "./types";

export class ExecutionPlan {
  constructor(
    private readonly ctx: CallContext,
    private readonly state: InternalBuildState,
    /**
     * When true, the orchestrator emits TDD-stage logs and captures per-phase
     * `beforeRef` so isolation `verify` hooks run. The single-session path
     * reuses implementerOp but has no boundary semantics, so this stays false
     * for that strategy. Set by `buildPlanForStrategy` based on `isThreeSessionStrategy`.
     */
    private readonly isThreeSession: boolean = false,
  ) {}

  /**
   * Returns the names of all phases in canonical execution order.
   * Phase names correspond to op.name on each RunOperation.
   * When rectification is configured, the sentinel "rectification" appears last.
   */
  phaseNames(): readonly string[] {
    const names = collectOrderedPhases(this.state).map((p) => p.slot.op.name);
    if (this.state.rectification) {
      return [...names, "rectification"];
    }
    return names;
  }

  /**
   * Sequences the orchestrator's phases, in the order described by each
   * phase function in ./execution-plan-phases.ts (complexity drain A3,
   * docs/plans/STATUS-complexity-drain.md): resume hydration, the canonical
   * loop, rectification, the post-rectification and mechanical-only resume
   * loops, the ADR-024 non-blocking fix, and verdict aggregation.
   */
  async run(): Promise<StoryOrchestratorResult> {
    const startedAt = Date.now();
    const plan: PlanParams = { ctx: this.ctx, state: this.state, isThreeSession: this.isThreeSession };

    const tracking = await hydrateResumeState(plan);
    const orderedPhases = collectOrderedPhases(this.state);
    const { shortCircuitPhase } = await runCanonicalLoop(plan, tracking, orderedPhases);

    // Baseline of gate failures the verifier implicitly blessed. The canonical
    // loop halts on any phase failure (no exemptions), so a verifier that
    // ran-and-passed means the gate was green at that point — any gate
    // failure observed after rectification was therefore introduced by it.
    // Captured before any rectification (including the ADR-024 non-blocking
    // pass) mutates the gate.
    const gateName = this.state.fullSuiteGate?.slot.op.name;
    const preRectGateFailureKeys = gateName ? gateFailureKeys(tracking.phaseOutputs[gateName]) : new Set<string>();

    const rectResult = await runRectification(this.ctx, this.state, tracking.phaseCosts, tracking.phaseOutputs, {
      gateBaselineKeys: preRectGateFailureKeys,
      isThreeSession: this.isThreeSession,
    });

    // Part A (#1666): also the deciding line for whether a still-missing
    // required review phase is attributable to the canonical loop's
    // short-circuit, or to the post-rectification resume loop's own halt
    // (US-002) — see runPostRectificationResume's own header.
    const resumeLoopEligible =
      !!this.state.rectification &&
      !rectResult.terminalReviewRequired &&
      (!rectResult.rectificationExhausted || !!rectResult.liteScopeIncomplete);
    if (resumeLoopEligible) {
      const resumeCompleted = await runPostRectificationResume(plan, tracking, preRectGateFailureKeys);
      if (resumeCompleted) settleProvisionalRectification(tracking.phaseOutputs);
    }

    if (this.state.rectification && rectResult.rectificationExhausted) {
      await runMechanicalOnlyResume(plan, tracking, rectResult);
    }

    await maybeRunNonBlockingFix(plan, tracking, rectResult, { gateName, preRectGateFailureKeys });

    return buildStoryOrchestratorResult(plan, tracking, {
      gateName,
      preRectGateFailureKeys,
      shortCircuitPhase,
      resumeLoopEligible,
      rectResult,
      startedAt,
    });
  }
}
