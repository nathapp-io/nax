/**
 * Verdict aggregation for `ExecutionPlan.run()` (./execution-plan.ts).
 *
 * Split out of ./execution-plan-phases.ts during the complexity drain
 * (docs/plans/STATUS-complexity-drain.md A3): that file landed at 625 lines
 * against the 600-line gate once the verdict logic joined the other
 * extracted phases. A pure extraction: no verdict rule changed.
 */

import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import { describeGateRegressionNow, type PhaseTracking, type PlanParams } from "./execution-plan-phases";
import { phaseExplicitlyPassed, phasePassed } from "./phase-eval";
import { recordReviewRecurrencesForAttempt } from "./recurrence-recording";
import { classifyMissingReviewPhases } from "./review-phase-report";
import type { RectificationResult, StoryOrchestratorResult } from "./types";

export interface VerdictInputs {
  gateName: string | undefined;
  preRectGateFailureKeys: ReadonlySet<string>;
  shortCircuitPhase: string | undefined;
  resumeLoopEligible: boolean;
  rectResult: RectificationResult;
  startedAt: number;
}

/**
 * Aggregate success across every op that produced output, including fix-ops
 * dispatched during rectification (spec §2C / AC: "success === false when any
 * op returns { success: false }"), and assemble the final result + summary log.
 *
 * Verifier-as-SSOT carve-out: when a verifier ran AND passed, the full-suite
 * gate's failure represents pre-existing/unrelated regressions (verifier's
 * judgment). Exempt the gate from aggregation so the story doesn't roll back
 * over failures it didn't cause. The gate output stays in `phaseOutputs` for
 * diagnostics; rectification (when configured) still consumes its findings.
 *
 * Staleness guard: the verifier judged the *pre-rectification* tree. If
 * rectification then introduced NEW gate failures (keys absent from the
 * verifier-time baseline), the verdict is stale for those — it can no longer
 * exempt the gate, else a review-fix that breaks a test is silently laundered
 * into a pass and leaks to the deferred regression sweep.
 *
 * Completeness guard (US-002): a configured review phase absent from
 * phaseOutputs never ran — the post-rectification resume loop can break at a
 * still-red full-suite-gate (canonical pos 4) before reaching the reviews
 * (pos 9-10). The verifier-SSOT carve-out must NOT launder such a story into
 * a pass: it cannot be certified without the semantic/adversarial judgment it
 * was configured to require. Forcing success=false routes it to escalation
 * (deriveTddFailureCategory → "review-incomplete") so a stronger tier can
 * green the gate and actually run the review; the story becomes terminal only
 * once escalation is exhausted.
 */
export function buildStoryOrchestratorResult(
  plan: PlanParams,
  tracking: PhaseTracking,
  inputs: VerdictInputs,
): StoryOrchestratorResult {
  const { ctx, state } = plan;
  const { phaseCosts, phaseOutputs } = tracking;
  const { gateName, preRectGateFailureKeys, shortCircuitPhase, resumeLoopEligible, rectResult, startedAt } = inputs;
  const logger = getSafeLogger();

  const verifierName = state.verifier?.slot.op.name;
  // SSOT requires an explicit pass — see `phaseExplicitlyPassed` for why we
  // don't use the defensive `phasePassed` here.
  const verifierExplicitlyPassed = verifierName !== undefined && phaseExplicitlyPassed(phaseOutputs[verifierName]);
  // Compares the FINAL gate against the verifier-time baseline, including keyless
  // (timeout / execution-failure) regressions the raw key-diff is blind to (audit #3).
  const gateRegressedDuringRect = describeGateRegressionNow(ctx, phaseOutputs, gateName, {
    baselineKeys: preRectGateFailureKeys,
  }).regressed;
  const verifierPassedSsot = verifierExplicitlyPassed && !gateRegressedDuringRect;
  if (verifierExplicitlyPassed && gateRegressedDuringRect) {
    logger?.warn(
      "story-orchestrator",
      "Gate regressed during rectification after verifier passed — verifier verdict is stale, failing story",
      { storyId: ctx.storyId, packageDir: ctx.packageDir },
    );
  } else if (
    verifierPassedSsot &&
    gateName !== undefined &&
    !phasePassed(gateName, phaseOutputs[gateName], ctx.storyId)
  ) {
    logger?.warn(
      "story-orchestrator",
      "Full-suite gate failed but verifier judged story OK — treating gate failures as unrelated regressions",
      { storyId: ctx.storyId, packageDir: ctx.packageDir },
    );
  }

  const requiredReviewPhaseNames = [state.semanticReview?.slot.op.name, state.adversarialReview?.slot.op.name].filter(
    (name): name is string => name !== undefined,
  );
  const missingRequiredReviewPhases = requiredReviewPhaseNames.filter((name) => !(name in phaseOutputs));

  // Part A (#1666) — see review-phase-report.ts for the two-cause classification
  // and why only one of them is suppressed from `failedPhases` below.
  const { upstreamShortCircuited, failedPhaseEntries } = classifyMissingReviewPhases({
    storyId: ctx.storyId,
    packageDir: ctx.packageDir,
    missingRequiredReviewPhases,
    shortCircuitPhase,
    resumeLoopEligible,
  });

  // Part C (#1666) — feed this attempt's review findings into the cross-attempt
  // recurrence store so `inspectRecurrenceBreaker` (post-run.ts) can see a same-source
  // finding repeating across escalation attempts. Runs regardless of `success` — the
  // breaker needs every attempt's data, not just failing ones.
  recordReviewRecurrencesForAttempt(ctx.runtime, ctx.storyId, phaseOutputs);

  const success =
    missingRequiredReviewPhases.length === 0 &&
    Object.entries(phaseOutputs).every(([name, output]) => {
      if (verifierPassedSsot && name === gateName) return true;
      return phasePassed(name, output, ctx.storyId);
    });
  const totalCostUsd = Object.values(phaseCosts).reduce((sum, cost) => sum + cost, 0);
  const durationMs = Date.now() - startedAt;

  logStoryOrchestratorVerdict(ctx, {
    success,
    phaseOutputs,
    totalCostUsd,
    durationMs,
    rectResult,
    missingRequiredReviewPhases,
    upstreamShortCircuited,
    shortCircuitPhase,
    failedPhaseEntries,
    gateName,
    verifierPassedSsot,
  });

  return {
    success,
    phaseCosts,
    totalCostUsd,
    durationMs,
    phaseOutputs,
    ...rectResult,
    gateRegressedDuringRect,
    missingRequiredReviewPhases: missingRequiredReviewPhases.length > 0 ? missingRequiredReviewPhases : undefined,
  };
}

interface VerdictLogInputs {
  success: boolean;
  phaseOutputs: Record<string, unknown>;
  totalCostUsd: number;
  durationMs: number;
  rectResult: RectificationResult;
  missingRequiredReviewPhases: readonly string[];
  upstreamShortCircuited: boolean;
  shortCircuitPhase: string | undefined;
  failedPhaseEntries: readonly string[];
  gateName: string | undefined;
  verifierPassedSsot: boolean;
}

/** Single end-of-run summary log so anyone reading the JSONL can see the orchestrator's verdict without correlating per-phase lines. */
function logStoryOrchestratorVerdict(ctx: CallContext, inputs: VerdictLogInputs): void {
  const {
    success,
    phaseOutputs,
    totalCostUsd,
    durationMs,
    rectResult,
    missingRequiredReviewPhases,
    upstreamShortCircuited,
    shortCircuitPhase,
    failedPhaseEntries,
    gateName,
    verifierPassedSsot,
  } = inputs;
  const logger = getSafeLogger();

  const failedPhases = [
    ...Object.entries(phaseOutputs)
      .filter(([name, output]) => {
        if (verifierPassedSsot && name === gateName) return false;
        return !phasePassed(name, output, ctx.storyId);
      })
      .map(([name]) => name),
    // Part A (#1666): `failedPhaseEntries` excludes review phases skipped by an
    // upstream short-circuit — see review-phase-report.ts.
    ...failedPhaseEntries.map((name) => `${name} (never ran)`),
  ];
  const summary: Record<string, unknown> = {
    storyId: ctx.storyId,
    success,
    // #2006: sum of the phases the orchestrator ran — not the story total
    // (see storySpendUsd); the two are different accounting bases, not a bug.
    orchestratedCostUsd: totalCostUsd,
    durationMs,
    phaseCount: Object.keys(phaseOutputs).length,
    failedPhases: failedPhases.length > 0 ? failedPhases : undefined,
  };
  if (rectResult.rectificationExhausted) summary.rectificationExhausted = true;
  if (rectResult.repoScopedFixes?.length) {
    // #1658 — surfaced on the story summary, not only in the rectification log,
    // because the fact that matters is a property of the finished story: its
    // commit carries files the story did not set out to change. An empty
    // `filesChanged` next to `success: true` is the sharpest case — a session
    // was spent, nothing was repaired, and the story passed on the carve-out.
    summary.repoScopedFixes = rectResult.repoScopedFixes.map((fix) => ({
      triggeringTests: fix.triggeringTests,
      filesChanged: fix.filesChanged,
      findingsCleared: fix.findingsCleared,
    }));
  }
  if (rectResult.unfixedFindings) summary.unfixedFindingsCount = rectResult.unfixedFindings.length;
  if (missingRequiredReviewPhases.length > 0) {
    summary.missingRequiredReviewPhases = missingRequiredReviewPhases;
    // Part A (#1666): distinct key so the upstream-short-circuit cause is not
    // lost even though it is excluded from `failedPhases` above.
    if (upstreamShortCircuited) {
      summary.reviewPhasesSkippedByShortCircuit = missingRequiredReviewPhases;
      summary.shortCircuitPhase = shortCircuitPhase;
    }
  }
  if (success) {
    logger?.info("story-orchestrator", "Story orchestration complete", summary);
  } else {
    logger?.warn("story-orchestrator", "Story orchestration failed", summary);
  }
}
