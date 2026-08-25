/**
 * Rectification oscillation circuit-breaker (US-002).
 *
 * Pure decision: given a per-story oscillation count and the
 * `review.conflictDetection` config, decide whether the story should be
 * paused (circuit tripped) or allowed to continue escalating. The actual
 * `notify` delivery and the `StageAction` construction live in
 * `decideStageAction` (post-run.ts) — this module just answers the
 * threshold question and the reason text so post-run.ts stays under the
 * 600-line file-size limit.
 */
import type { PipelineContext } from "@/pipeline";
import { getOscillations } from "./oscillation-store";

export interface BreakerDecision {
  /** True when the breaker should fire (count >= maxOscillations). */
  readonly trip: boolean;
  /** Cumulative oscillation count (0 when runtime/config unavailable). */
  readonly count: number;
  /** Effective maxOscillations (defaults to 2 when config absent). */
  readonly maxOscillations: number;
  /** Human-readable reason (only populated when `trip` is true). */
  readonly reason: string;
}

const DEFAULT_MAX_OSCILLATIONS = 2;

/**
 * Inspect the runtime oscillation counter and the project's
 * `review.conflictDetection` config. Fail-open: when either is missing or
 * the breaker is disabled, `trip` is false and the caller is expected to
 * continue with the legacy escalation path.
 */
export function inspectOscillationBreaker(ctx: PipelineContext): BreakerDecision {
  const conflictDetection = ctx.config?.review?.conflictDetection;
  const oscillationStore = ctx.runtime?.rectificationOscillations;
  if (conflictDetection?.enabled !== true || !oscillationStore) {
    return {
      trip: false,
      count: 0,
      maxOscillations: conflictDetection?.maxOscillations ?? DEFAULT_MAX_OSCILLATIONS,
      reason: "",
    };
  }
  const count = getOscillations(oscillationStore, ctx.story.id);
  const maxOscillations = conflictDetection.maxOscillations ?? DEFAULT_MAX_OSCILLATIONS;
  if (count >= maxOscillations) {
    return {
      trip: true,
      count,
      maxOscillations,
      reason: `Rectification oscillation threshold reached: ${count} regressed-different-source iterations across attempts (max ${maxOscillations})`,
    };
  }
  return { trip: false, count, maxOscillations, reason: "" };
}
