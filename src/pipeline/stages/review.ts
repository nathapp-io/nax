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
import { join } from "node:path";
import { getAgent } from "../../agents";
import { checkSecurityReview, isTriggerEnabled } from "../../interaction/triggers";
import { getLogger } from "../../logger";
import { reviewOrchestrator } from "../../review/orchestrator";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const reviewStage: PipelineStage = {
  name: "review",
  enabled: (ctx) => (ctx.effectiveConfig ?? ctx.config).review.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    // PKG-004: use centrally resolved effective config
    const effectiveConfig = ctx.effectiveConfig ?? ctx.config;

    logger.info("review", "Running review phase", { storyId: ctx.story.id });

    // MW-010: scope review to package directory when story.workdir is set
    const effectiveWorkdir = ctx.story.workdir ? join(ctx.workdir, ctx.story.workdir) : ctx.workdir;

    // Build model resolver for semantic review — returns the default agent adapter.
    // The tier param from SemanticReviewConfig is informational (selects model cost tier)
    // but AgentAdapter.complete() always uses the agent's own configured model.
    const agentResolver = ctx.agentGetFn ?? getAgent;
    const agentName = effectiveConfig.autoMode?.defaultAgent;
    const modelResolver = (_tier: string) => (agentName ? (agentResolver(agentName) ?? null) : null);

    const result = await reviewOrchestrator.review(
      effectiveConfig.review,
      effectiveWorkdir,
      effectiveConfig.execution,
      ctx.plugins,
      ctx.storyGitRef,
      ctx.story.workdir, // MW-010: scope changed-file checks to package
      effectiveConfig.quality?.commands, // fallback for review.commands
      ctx.story.id,
      {
        id: ctx.story.id,
        title: ctx.story.title,
        description: ctx.story.description,
        acceptanceCriteria: ctx.story.acceptanceCriteria,
      },
      modelResolver,
    );

    ctx.reviewResult = result.builtIn;

    if (!result.success) {
      // Collect structured findings from plugin reviewers for escalation context
      const pluginFindings = result.builtIn.pluginReviewers?.flatMap((pr) => pr.findings ?? []) ?? [];
      // Collect semantic findings from built-in checks (AC-1/AC-2/AC-3)
      const semanticFindings = (result.builtIn.checks ?? [])
        .filter((c) => c.check === "semantic" && !c.success && c.findings?.length)
        .flatMap((c) => c.findings ?? []);
      const allFindings = [...pluginFindings, ...semanticFindings];
      if (allFindings.length > 0) {
        ctx.reviewFindings = allFindings;
      }

      if (result.pluginFailed) {
        // security-review trigger: prompt before permanently failing
        if (ctx.interaction && isTriggerEnabled("security-review", effectiveConfig)) {
          const shouldContinue = await _reviewDeps.checkSecurityReview(
            { featureName: ctx.prd.feature, storyId: ctx.story.id },
            effectiveConfig,
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

      logger.warn("review", "Review failed (built-in checks) — handing off to autofix", {
        reason: result.failureReason,
        storyId: ctx.story.id,
      });
      // ctx.reviewResult is already set with success:false — autofixStage handles it next
      return { action: "continue" };
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
