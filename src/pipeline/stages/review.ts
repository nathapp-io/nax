/**
 * Review Stage (ADR-005, Phase 2)
 *
 * Delegates to ReviewOrchestrator for built-in checks + plugin reviewers.
 *
 * @returns
 * - `continue`: Review passed
 * - `escalate`: Built-in check failed (lint/typecheck) — autofix stage handles retry
 * - `fail`: Plugin reviewer hard-failed
 */

// RE-ARCH: rewrite
import { getLogger } from "../../logger";
import { reviewOrchestrator } from "../../review/orchestrator";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const reviewStage: PipelineStage = {
  name: "review",
  enabled: (ctx) => ctx.config.review.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    logger.info("review", "Running review phase", { storyId: ctx.story.id });

    const result = await reviewOrchestrator.review(ctx.config.review, ctx.workdir, ctx.config.execution, ctx.plugins);

    ctx.reviewResult = result.builtIn;

    if (!result.success) {
      if (result.pluginFailed) {
        logger.error("review", `Plugin reviewer failed: ${result.failureReason}`, { storyId: ctx.story.id });
        return { action: "fail", reason: `Review failed: ${result.failureReason}` };
      }

      logger.warn("review", "Review failed (built-in checks) — escalating for retry", {
        reason: result.failureReason,
        storyId: ctx.story.id,
      });
      return { action: "escalate", reason: `Review failed: ${result.failureReason}` };
    }

    logger.info("review", "Review passed", {
      durationMs: result.builtIn.totalDurationMs,
      storyId: ctx.story.id,
    });
    return { action: "continue" };
  },
};
