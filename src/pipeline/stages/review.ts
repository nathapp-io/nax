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
import { createReviewerSession } from "../../review/dialogue";
import { reviewOrchestrator } from "../../review/orchestrator";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const reviewStage: PipelineStage = {
  name: "review",
  enabled: (ctx) => ctx.config.review.enabled,

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();

    const reviewDebateEnabled = ctx.rootConfig?.debate?.enabled && ctx.rootConfig?.debate?.stages?.review?.enabled;
    const dialogueEnabled = ctx.config.review?.dialogue?.enabled ?? false;

    logger.info("review", "Running review phase", { storyId: ctx.story.id });

    // MW-010: workdir is already resolved to the package directory at context creation

    // AC3: When dialogue is enabled (non-debate) and a session already exists (retry loop), use reReview()
    if (dialogueEnabled && !reviewDebateEnabled && ctx.reviewerSession) {
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
    if (dialogueEnabled && !ctx.reviewerSession && ctx.agentManager) {
      ctx.reviewerSession = _reviewDeps.createReviewerSession(
        ctx.agentManager,
        ctx.story.id,
        ctx.workdir,
        ctx.prd.feature ?? "",
        ctx.config,
      );

      // For debate+dialogue: session stored, fall through to orchestrator (which uses reReviewDebate/resolveDebate)
      // For pure dialogue (no debate): try direct session.review(); fall back to orchestrator on error (AC9)
      if (!reviewDebateEnabled) {
        const semanticConfig = ctx.config.review?.semantic;
        if (semanticConfig && ctx.agentManager) {
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
            const dialogueCost = sessionResult.cost ?? 0;
            if (passed) {
              logger.info("review", "Review passed (dialogue session)", { storyId: ctx.story.id });
            } else {
              logger.warn("review", "Review failed (dialogue session) — handing off to autofix", {
                storyId: ctx.story.id,
              });
            }
            return { action: "continue", cost: dialogueCost || undefined };
          } catch (err) {
            logger.warn("review", "ReviewerSession.review() failed — falling back to one-shot review", {
              storyId: ctx.story.id,
            });
            // Fall through to orchestrator (AC9)
          }
        }
      }
      // No semanticConfig/agentManager, debate mode, or AC9 fallback — fall through to orchestrator
    }

    // reviewFromContext reads and clears ctx.retrySkipChecks internally (#136)
    const result = await reviewOrchestrator.reviewFromContext(ctx);

    ctx.reviewResult = result.builtIn;
    ctx.mechanicalFailedOnly = result.mechanicalFailedOnly;

    // Sum LLM costs from checks (populated by semantic review)
    const reviewCost = (result.builtIn.checks ?? []).reduce((sum, c) => sum + (c.cost ?? 0), 0) || undefined;

    // Fail-closed when fail-open occurs in a retry context (autofix has already run ≥1 time).
    // A reviewer that cannot parse its LLM response is ambiguous — it must not count as a
    // genuine pass when the review was previously failing with real blocking findings.
    const failOpenChecks = result.success
      ? (result.builtIn.checks ?? []).filter((c) => c.failOpen).map((c) => c.check)
      : [];
    if (failOpenChecks.length > 0 && (ctx.autofixAttempt ?? 0) > 0) {
      logger.warn("review", "Fail-open on partial-progress retry — treating as failure (fail-closed on ambiguity)", {
        storyId: ctx.story.id,
        failOpenChecks,
        autofixAttempt: ctx.autofixAttempt,
      });
      ctx.reviewResult = {
        ...result.builtIn,
        success: false,
        failureReason: `fail-open on retry: ${failOpenChecks.join(", ")}`,
      };
      return { action: "continue", cost: reviewCost };
    }

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
            return { action: "fail", reason: `Review failed: ${result.failureReason}`, cost: reviewCost };
          }
          logger.warn("review", "Security-review trigger escalated — retrying story", { storyId: ctx.story.id });
          return { action: "escalate", reason: `Review failed: ${result.failureReason}`, cost: reviewCost };
        }

        logger.error("review", `Plugin reviewer failed: ${result.failureReason}`, { storyId: ctx.story.id });
        return { action: "fail", reason: `Review failed: ${result.failureReason}`, cost: reviewCost };
      }

      logger.warn("review", "Review failed (built-in checks) — handing off to autofix", {
        reason: result.failureReason,
        storyId: ctx.story.id,
      });
      // ctx.reviewResult is already set with success:false — autofixStage handles it next
      return { action: "continue", cost: reviewCost };
    }

    logger.info("review", "Review passed", {
      durationMs: result.builtIn.totalDurationMs,
      storyId: ctx.story.id,
    });
    return { action: "continue", cost: reviewCost };
  },
};

/**
 * Swappable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 */
export const _reviewDeps = {
  checkSecurityReview,
  createReviewerSession,
};
