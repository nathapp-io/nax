/**
 * Review Stage (ADR-005, Phase 2)
 *
 * Delegates to ReviewOrchestrator for built-in checks + plugin reviewers.
 *
 * @returns
 * - `continue`: Review passed
 * - `escalate`: Built-in check failed (lint/typecheck) — autofix stage handles retry
 * - `escalate`: Plugin reviewer failed and security-review trigger responded non-abort
 * - `fail`: Plugin reviewer hard-failed (no trigger, or trigger responded abort)
 */

// RE-ARCH: rewrite
import { checkSecurityReview, isTriggerEnabled } from "../../interaction/triggers";
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
        // security-review trigger: prompt before permanently failing
        if (ctx.interaction && isTriggerEnabled("security-review", ctx.config)) {
          const shouldContinue = await _reviewDeps.checkSecurityReview(
            { featureName: ctx.prd.feature, storyId: ctx.story.id },
            ctx.config,
            ctx.interaction,
          );
          if (!shouldContinue) {
            logger.error("review", `Plugin reviewer failed: ${result.failureReason}`, { storyId: ctx.story.id });
            return { action: "fail", reason: `Review failed: ${result.failureReason}` };
          }
          logger.warn("review", "Security-review trigger escalated — retrying story", { storyId: ctx.story.id });
          return { action: "escalate", reason: `Review failed: ${result.failureReason}` };
        }

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

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _reviewDeps = {
  checkSecurityReview,
};
