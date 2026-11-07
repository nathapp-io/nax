/**
 * ENH-20: count review checks that degraded to a fail-open pass (LLM
 * dispatch failed, gate returned success:true, failOpen:true) so the run
 * summary can distinguish "reviewed green" from "not actually checked".
 * Extracted from post-run.ts (itself deleted with the post-run inspection layer,
 * US-003) to stay within the 600-line file limit. `sumReviewsFailedOpen` feeds
 * `RunResult.reviewsFailedOpen`.
 */

import type { StoryMetrics } from "../metrics/types";

/**
 * Sums `StoryMetrics.reviewsFailedOpen` across a completed run, for
 * `RunResult.reviewsFailedOpen`. Omitted (not zero) when no story fail-opened,
 * so callers can gate a summary line on presence rather than a `> 0` check.
 */
export function sumReviewsFailedOpen(allStoryMetrics: readonly StoryMetrics[]): number | undefined {
  const total = allStoryMetrics.reduce((sum, m) => sum + (m.reviewsFailedOpen ?? 0), 0);
  return total > 0 ? total : undefined;
}
