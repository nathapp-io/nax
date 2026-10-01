import { getSafeLogger } from "@/logger";

export interface ReviewPhaseReportInput {
  readonly storyId?: string;
  readonly packageDir: string;
  /** Required review phase names (semantic-review / adversarial-review) absent from phaseOutputs. */
  readonly missingRequiredReviewPhases: readonly string[];
  /** The phase whose failure caused the main phase loop to stop early, if any. */
  readonly shortCircuitPhase: string | undefined;
  /** Whether the post-rectification resume loop ran (it walks the full canonical order, reviews included). */
  readonly resumeLoopEligible: boolean;
}

export interface ReviewPhaseReport {
  /**
   * True when every missing review phase is explained by an earlier phase's
   * short-circuit rather than an independent "never ran" condition.
   */
  readonly upstreamShortCircuited: boolean;
  /**
   * Review-phase names to append to `failedPhases` as "(never ran)" entries.
   * Empty when `upstreamShortCircuited` — that cause is already reported via
   * the originating phase's own `failedPhases` entry.
   */
  readonly failedPhaseEntries: readonly string[];
}

/**
 * Classify why required review phases (semantic-review / adversarial-review) are
 * missing from `phaseOutputs`, and log accordingly (#1666 Part A).
 *
 * Two distinct causes produce a missing required review phase:
 * - an upstream phase failure short-circuited the main phase loop before the
 *   review was reached, and the post-rectification resume loop never got a
 *   chance to retry it (`resumeLoopEligible === false`) — this issue;
 * - the post-rectification resume loop DID run (it walks the full canonical
 *   order, reviews included) but broke at a still-red full-suite-gate before
 *   reaching the review — the pre-existing US-002 completeness-guard case.
 *
 * Only the first cause is suppressed from `failedPhases`: it is already
 * reported via the originating phase's own entry there, and listing the review
 * phase again would double-report one root cause as two independent-looking
 * failures. The US-002 case is a genuine, distinct "never ran" condition and
 * keeps its existing reporting untouched.
 *
 * This function does not change the story verdict — `success` still requires
 * `missingRequiredReviewPhases.length === 0` regardless of cause (see
 * ExecutionPlan.run). It only changes how the failure is reported.
 */
export function classifyMissingReviewPhases(input: ReviewPhaseReportInput): ReviewPhaseReport {
  const { storyId, packageDir, missingRequiredReviewPhases, shortCircuitPhase, resumeLoopEligible } = input;
  const upstreamShortCircuited =
    missingRequiredReviewPhases.length > 0 && shortCircuitPhase !== undefined && !resumeLoopEligible;

  if (missingRequiredReviewPhases.length > 0) {
    const logger = getSafeLogger();
    if (upstreamShortCircuited) {
      logger?.warn(
        "story-orchestrator",
        "Required review phase(s) skipped — an earlier phase failure short-circuited the phase loop before they were reached",
        { storyId, packageDir, shortCircuitPhase, skippedReviewPhases: missingRequiredReviewPhases },
      );
    } else {
      logger?.warn(
        "story-orchestrator",
        "Configured review phase(s) never ran — story cannot pass without review judgment, failing for escalation",
        { storyId, packageDir, missingRequiredReviewPhases },
      );
    }
  }

  return {
    upstreamShortCircuited,
    failedPhaseEntries: upstreamShortCircuited ? [] : missingRequiredReviewPhases,
  };
}
