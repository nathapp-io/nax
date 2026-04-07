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
import { createReviewerSession } from "../../review/dialogue";
import { reviewOrchestrator } from "../../review/orchestrator";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const reviewStage: PipelineStage = {
  name: "review",
  enabled: (ctx) => ctx.config.review.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    const dialogueEnabled = ctx.config.review?.dialogue?.enabled ?? false;

    logger.info("review", "Running review phase", { storyId: ctx.story.id });

    // MW-010: scope review to package directory when story.workdir is set
    const effectiveWorkdir = ctx.story.workdir ? join(ctx.workdir, ctx.story.workdir) : ctx.workdir;

    // Build model resolver for semantic review — returns the default agent adapter.
    // The tier param from SemanticReviewConfig is informational (selects model cost tier)
    // but AgentAdapter.complete() always uses the agent's own configured model.
    const agentResolver = ctx.agentGetFn ?? getAgent;
    const agentName = ctx.rootConfig.autoMode?.defaultAgent;
    const modelResolver = (_tier: string) => (agentName ? (agentResolver(agentName) ?? null) : null);

    // #136: Consume retrySkipChecks once (cleared after use so subsequent retries re-evaluate)
    const retrySkipChecks = ctx.retrySkipChecks;
    ctx.retrySkipChecks = undefined;

    // AC3: When dialogue is enabled and a session already exists (retry loop), use reReview()
    if (dialogueEnabled && ctx.reviewerSession) {
      try {
        const diff = ctx.storyGitRef ?? "";
        const reReviewResult = await ctx.reviewerSession.reReview(diff);
        const passed = reReviewResult.checkResult.success;
        ctx.reviewResult = {
          success: passed,
          checks: passed
            ? []
            : [
                {
                  check: "semantic",
                  success: false,
                  command: "reviewer-session-rereview",
                  exitCode: 1,
                  output: reReviewResult.checkResult.findings.map((f) => f.message).join("\n"),
                  durationMs: 0,
                  findings: reReviewResult.checkResult.findings,
                },
              ],
          totalDurationMs: 0,
        };
        if (passed) {
          logger.info("review", "Review passed (dialogue reReview)", { storyId: ctx.story.id });
        } else {
          logger.warn("review", "Review failed (dialogue reReview) — handing off to autofix", {
            storyId: ctx.story.id,
          });
        }
        return { action: "continue" };
      } catch (err) {
        logger.warn("review", "ReviewerSession.reReview() failed — proceeding without dialogue", {
          storyId: ctx.story.id,
        });
        // Fall through to orchestrator
      }
    }

    // AC2: When dialogue is enabled and no session exists (first run), create one
    if (dialogueEnabled && !ctx.reviewerSession) {
      const agent = agentName ? (agentResolver(agentName) ?? null) : null;
      // Always create the session (agent may be provided by _reviewDeps mock in tests)
      ctx.reviewerSession = _reviewDeps.createReviewerSession(
        // biome-ignore lint/suspicious/noExplicitAny: agent may be null when no defaultAgent configured
        (agent ?? null) as any,
        ctx.story.id,
        effectiveWorkdir,
        ctx.prd.feature ?? "",
        ctx.config,
      );

      // AC9: Try using the session for the semantic review; fall back to orchestrator on error
      const semanticConfig = ctx.config.review?.semantic;
      if (semanticConfig && agent) {
        try {
          const diff = ctx.storyGitRef ?? "";
          const story = {
            id: ctx.story.id,
            title: ctx.story.title,
            description: ctx.story.description,
            acceptanceCriteria: ctx.story.acceptanceCriteria,
          };
          const sessionResult = await ctx.reviewerSession.review(diff, story, semanticConfig);
          const passed = sessionResult.checkResult.success;
          ctx.reviewResult = {
            success: passed,
            checks: passed
              ? []
              : [
                  {
                    check: "semantic",
                    success: false,
                    command: "reviewer-session-review",
                    exitCode: 1,
                    output: sessionResult.checkResult.findings.map((f) => f.message).join("\n"),
                    durationMs: 0,
                    findings: sessionResult.checkResult.findings,
                  },
                ],
            totalDurationMs: 0,
          };
          if (passed) {
            logger.info("review", "Review passed (dialogue session)", { storyId: ctx.story.id });
          } else {
            logger.warn("review", "Review failed (dialogue session) — handing off to autofix", {
              storyId: ctx.story.id,
            });
          }
          return { action: "continue" };
        } catch (err) {
          logger.warn("review", "ReviewerSession.review() failed — falling back to one-shot review", {
            storyId: ctx.story.id,
          });
          // Fall through to orchestrator (AC9)
        }
      }
      // No semanticConfig or agent — fall through to orchestrator with session stored
    }

    const result = await reviewOrchestrator.review(
      ctx.config.review,
      effectiveWorkdir,
      ctx.config.execution,
      ctx.plugins,
      ctx.storyGitRef,
      ctx.story.workdir, // MW-010: scope changed-file checks to package
      ctx.config.quality?.commands, // fallback for review.commands
      ctx.story.id,
      {
        id: ctx.story.id,
        title: ctx.story.title,
        description: ctx.story.description,
        acceptanceCriteria: ctx.story.acceptanceCriteria,
      },
      modelResolver,
      ctx.config,
      retrySkipChecks,
      ctx.prd.feature,
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
  createReviewerSession,
};
