/**
 * Review Stage
 *
 * Runs post-implementation review phase if enabled.
 * Checks code quality, tests, linting, etc. via review module.
 *
 * @returns
 * - `continue`: Review passed
 * - `fail`: Review failed (hard failure)
 *
 * @example
 * ```ts
 * // Review enabled and passes
 * await reviewStage.execute(ctx);
 * // ctx.reviewResult: { success: true, totalDurationMs: 1500, ... }
 *
 * // Review enabled but fails
 * await reviewStage.execute(ctx);
 * // Returns: { action: "fail", reason: "Review failed: typecheck errors" }
 * ```
 */

import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { runReview } from "../../review";
import { getLogger } from "../../logger";

export const reviewStage: PipelineStage = {
  name: "review",
  enabled: (ctx) => ctx.config.review.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    logger.info("review", "Running review phase");

    const reviewResult = await runReview(ctx.config.review, ctx.workdir);
    ctx.reviewResult = reviewResult;

    // HARD FAILURE: Review failure means code quality gate not met
    if (!reviewResult.success) {
      logger.error("review", "Review failed", {
        reason: reviewResult.failureReason,
        storyId: ctx.story.id,
      });
      return { action: "fail", reason: `Review failed: ${reviewResult.failureReason}` };
    }

    logger.info("review", "Review passed", {
      durationMs: reviewResult.totalDurationMs,
      storyId: ctx.story.id,
    });
    return { action: "continue" };
  },
};
