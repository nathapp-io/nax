/**
 * Cross-attempt review-recurrence circuit-breaker (#1666 Part C).
 *
 * Pure decision: given the runtime's per-story, per-reviewer-source recurrence
 * counts and the `review.conflictDetection` config, decide whether the story
 * should be paused (breaker tripped) or allowed to keep escalating. Mirrors
 * `oscillation-breaker.ts`'s shape exactly — same fail-open contract, same
 * split between "pure decision" here and delivery (`notify` + `StageAction`) in
 * `post-run.ts` — but reads `recurrenceStore` / `maxCrossAttemptRecurrences`
 * instead of `rectificationOscillations` / `maxOscillations`. This is a
 * PARALLEL breaker, not a replacement: `inspectOscillationBreaker` still covers
 * the within-cycle ping-pong case.
 */
import type { PipelineContext } from "@/pipeline";
import { getReviewRecurrenceCount, type ReviewRecurrenceStore } from "./recurrence-store";

export interface RecurrenceBreakerDecision {
  /** True when the breaker should fire (some reviewer source's count >= threshold). */
  readonly trip: boolean;
  /** The reviewer source that tripped the breaker, if any. */
  readonly source?: string;
  /** That source's cumulative cross-attempt recurrence count. */
  readonly count: number;
  /** Effective maxCrossAttemptRecurrences (defaults to 2 when config absent). */
  readonly maxCrossAttemptRecurrences: number;
  /** Human-readable reason (only populated when `trip` is true). */
  readonly reason: string;
}

const DEFAULT_MAX_CROSS_ATTEMPT_RECURRENCES = 2;

/** Reviewer sources this breaker watches — the two review phases Part B keeps both dispatching. */
const REVIEW_SOURCES = ["semantic-review", "adversarial-review"] as const;

/**
 * Inspect the runtime's cross-attempt recurrence store against the project's
 * `review.conflictDetection` config. Fail-open: when either is missing or the
 * breaker is disabled, `trip` is false and the caller continues with the
 * existing escalation path — exactly as `inspectOscillationBreaker` does.
 */
export function inspectRecurrenceBreaker(ctx: PipelineContext): RecurrenceBreakerDecision {
  const conflictDetection = ctx.config?.review?.conflictDetection;
  const store = ctx.runtime?.reviewFindingRecurrences as ReviewRecurrenceStore | undefined;
  const maxCrossAttemptRecurrences =
    conflictDetection?.maxCrossAttemptRecurrences ?? DEFAULT_MAX_CROSS_ATTEMPT_RECURRENCES;

  if (conflictDetection?.enabled !== true || !store) {
    return { trip: false, count: 0, maxCrossAttemptRecurrences, reason: "" };
  }

  for (const source of REVIEW_SOURCES) {
    const count = getReviewRecurrenceCount(store, ctx.story.id, source);
    if (count >= maxCrossAttemptRecurrences) {
      return {
        trip: true,
        source,
        count,
        maxCrossAttemptRecurrences,
        reason:
          `Cross-attempt review deadlock: reviewer "${source}" produced the same finding across ${count} ` +
          `later attempt(s) (max ${maxCrossAttemptRecurrences}) — this looks like two reviewers disagreeing ` +
          `on the same code, not the implementer failing to fix a finding`,
      };
    }
  }

  return { trip: false, count: 0, maxCrossAttemptRecurrences, reason: "" };
}
