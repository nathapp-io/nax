/**
 * Wires the per-attempt review outputs into the cross-attempt recurrence store
 * (#1666 Part C). Called once per `ExecutionPlan.run()` attempt, after
 * `phaseOutputs` is finalized, so the store sees exactly what this attempt's
 * reviewers produced — including the case Part B enables, where
 * adversarial-review ran on the same tree that semantic-review failed.
 *
 * No-op when `storyId` is absent (ad-hoc calls with no story context) or the
 * runtime lacks the store — recording is best-effort bookkeeping, not a
 * correctness requirement; `inspectRecurrenceBreaker` is separately fail-open.
 */
import { type ReviewRecurrenceStore, recordReviewFindings } from "../recurrence-store";
import { extractPhaseFindings } from "./phase-eval";

/** Reviewer phase names this recording covers — the two Part B keeps both dispatching. */
const RECORDED_REVIEW_PHASES = ["semantic-review", "adversarial-review"] as const;

export function recordReviewRecurrencesForAttempt(
  runtime: { reviewFindingRecurrences?: ReviewRecurrenceStore } | undefined,
  storyId: string | undefined,
  phaseOutputs: Record<string, unknown>,
): void {
  const store = runtime?.reviewFindingRecurrences;
  if (!storyId || !store) return;
  for (const source of RECORDED_REVIEW_PHASES) {
    if (!(source in phaseOutputs)) continue;
    recordReviewFindings(store, storyId, source, extractPhaseFindings(phaseOutputs[source]));
  }
}
