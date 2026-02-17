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

import chalk from "chalk";
import type { PipelineStage, PipelineContext, StageResult } from "../types";
import { runReview } from "../../review";

export const reviewStage: PipelineStage = {
  name: "review",
  enabled: (ctx) => ctx.config.review.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    console.log(chalk.cyan("\n   → Running review phase..."));

    const reviewResult = await runReview(ctx.config.review, ctx.workdir);
    ctx.reviewResult = reviewResult;

    // HARD FAILURE: Review failure means code quality gate not met
    if (!reviewResult.success) {
      console.log(chalk.red(`   ✗ Review failed: ${reviewResult.failureReason}`));
      return { action: "fail", reason: `Review failed: ${reviewResult.failureReason}` };
    }

    console.log(chalk.green(`   ✓ Review passed (${reviewResult.totalDurationMs}ms)`));
    return { action: "continue" };
  },
};
