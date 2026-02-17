/**
 * Review Stage
 *
 * Runs post-implementation review phase if enabled.
 * Checks code quality, tests, linting, etc.
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

    if (!reviewResult.success) {
      console.log(chalk.red(`   ✗ Review failed: ${reviewResult.failureReason}`));
      return { action: "fail", reason: `Review failed: ${reviewResult.failureReason}` };
    }

    console.log(chalk.green(`   ✓ Review passed (${reviewResult.totalDurationMs}ms)`));
    return { action: "continue" };
  },
};
