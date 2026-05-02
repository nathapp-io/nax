// RE-ARCH: keep
/**
 * Autofix Stage (ADR-005, Phase 2)
 *
 * Runs after a failed review stage. Attempts to fix quality issues
 * automatically before escalating:
 *
 * Phase 1 — Mechanical fix: runs lintFix / formatFix commands (if configured)
 * Phase 2 — Agent rectification: spawns an agent session with the review error
 *            output as context (reuses the pattern from rectification-loop.ts)
 *
 * Language-agnostic: uses quality.commands.lintFix / formatFix from config.
 * No hardcoded tool names.
 *
 * Enabled only when ctx.reviewResult?.passed === false AND autofix is enabled.
 *
 * Returns:
 * - `retry` fromStage:"review" — autofix resolved the failures
 * - `escalate`                 — max attempts exhausted or agent unavailable
 */

import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { runQualityCommand } from "../../quality";
import type { ReviewCheckResult } from "../../review/types";
import { captureGitRef } from "../../utils/git";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";
import { runTestWriterRectification, splitFindingsByScope } from "./autofix-adversarial";

export const autofixStage: PipelineStage = {
  name: "autofix",

  enabled(ctx: PipelineContext): boolean {
    if (!ctx.reviewResult) return false;
    if (ctx.reviewResult.success) return false;
    const autofixEnabled = ctx.config.quality.autofix?.enabled ?? true;
    return autofixEnabled;
  },

  skipReason(ctx: PipelineContext): string {
    if (!ctx.reviewResult || ctx.reviewResult.success) return "not needed (review passed)";
    return "disabled (autofix not enabled in config)";
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const { reviewResult } = ctx;

    if (!reviewResult || reviewResult.success) {
      return { action: "continue" };
    }

    // Check quality.commands first, then fall back to review.commands — users often define
    // lintFix/formatFix in review.commands alongside other review commands (lint, typecheck).
    const lintFixCmd = ctx.config.quality.commands.lintFix ?? ctx.config.review.commands.lintFix;
    const formatFixCmd = ctx.config.quality.commands.formatFix ?? ctx.config.review.commands.formatFix;

    // Effective workdir for running commands — workdir is already resolved at context creation

    // Identify which checks failed
    const failedCheckNames = new Set((reviewResult.checks ?? []).filter((c) => !c.success).map((c) => c.check));
    const hasLintFailure = failedCheckNames.has("lint");

    logger.info("autofix", "Starting autofix", {
      storyId: ctx.story.id,
      failedChecks: [...failedCheckNames],
      workdir: ctx.workdir,
    });

    // Phase 1: Mechanical fix — only for lint failures (lintFix/formatFix cannot fix typecheck errors)
    if (hasLintFailure && (lintFixCmd || formatFixCmd)) {
      if (lintFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: lintFixCmd });
        const lintResult = await _autofixDeps.runQualityCommand({
          commandName: "lintFix",
          command: lintFixCmd,
          workdir: ctx.workdir,
          storyId: ctx.story.id,
        });
        logger.debug("autofix", `lintFix exit=${lintResult.exitCode}`, { storyId: ctx.story.id, command: lintFixCmd });
        if (lintResult.exitCode !== 0) {
          logger.warn("autofix", "lintFix command failed — may not have fixed all issues", {
            storyId: ctx.story.id,
            exitCode: lintResult.exitCode,
          });
        }
      }

      if (formatFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: formatFixCmd });
        const fmtResult = await _autofixDeps.runQualityCommand({
          commandName: "formatFix",
          command: formatFixCmd,
          workdir: ctx.workdir,
          storyId: ctx.story.id,
        });
        logger.debug("autofix", `formatFix exit=${fmtResult.exitCode}`, {
          storyId: ctx.story.id,
          command: formatFixCmd,
        });
        if (fmtResult.exitCode !== 0) {
          logger.warn("autofix", "formatFix command failed — may not have fixed all issues", {
            storyId: ctx.story.id,
            exitCode: fmtResult.exitCode,
          });
        }
      }

      const recheckPassed = await _autofixDeps.recheckReview(ctx);
      pipelineEventBus.emit({ type: "autofix:completed", storyId: ctx.story.id, fixed: recheckPassed });

      if (recheckPassed) {
        // #136: Skip checks that already passed — mechanical fix only touched lint/format.
        // Semantic/debate review doesn't need to re-run after a lint-only fix.
        const passedChecks = (ctx.reviewResult?.checks ?? [])
          .filter((c) => c.success && !c.skipped)
          .map((c) => c.check);
        if (passedChecks.length > 0) {
          ctx.retrySkipChecks = new Set(passedChecks);
          logger.debug("autofix", "Skipping already-passed checks on retry", {
            storyId: ctx.story.id,
            skippedChecks: passedChecks,
          });
        }
        logger.info("autofix", "Mechanical autofix succeeded — retrying review", { storyId: ctx.story.id });
        return { action: "retry", fromStage: "review" };
      }

      logger.info("autofix", "Mechanical autofix did not resolve all failures — proceeding to agent rectification", {
        storyId: ctx.story.id,
      });
    }

    // STRAT-001: no-test stories never write tests, so adversarial findings scoped to test
    // files are irrelevant and unresolvable within the story's scope.  When every failing
    // check is an adversarial check whose findings are all test-file scoped, treat the
    // review as passed (with a warning) rather than launching any agent session.
    const testFilePatterns =
      typeof ctx.rootConfig.execution?.smartTestRunner === "object"
        ? ctx.rootConfig.execution.smartTestRunner?.testFilePatterns
        : undefined;
    const lintOutputFormat = ctx.config.quality.lintOutput?.format ?? "auto";
    const typecheckOutputFormat = ctx.config.quality.typecheckOutput?.format ?? "auto";
    if (ctx.routing.testStrategy === "no-test") {
      const failedChecks = (reviewResult.checks ?? []).filter((c) => !c.success);
      if (
        failedChecks.length > 0 &&
        failedChecks.every((c) => {
          const { testFindings, sourceFindings } = splitFindingsByScope(
            c,
            testFilePatterns,
            lintOutputFormat,
            typecheckOutputFormat,
          );
          return testFindings !== null && sourceFindings === null;
        })
      ) {
        const skippedFindingCount = failedChecks.flatMap((c) => c.findings ?? []).length;
        logger.warn("autofix", "Review found test-file issues only — skipped (no-test strategy)", {
          storyId: ctx.story.id,
          skippedFindingCount,
        });
        if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
        return { action: "continue" };
      }
    }

    // Phase 2: Agent rectification — spawn agent with review error context
    const {
      succeeded: agentFixed,
      cost: agentCost,
      unresolvedReason,
    } = await _autofixDeps.runAgentRectification(ctx, lintFixCmd, formatFixCmd, ctx.workdir);

    // REVIEW-003: Implementer signalled an unresolvable reviewer contradiction.
    if (unresolvedReason) {
      // When only mechanical checks failed (LLM/semantic passed), the code is functionally
      // correct — the agent cannot fix lint/typecheck errors in test files per its constraints.
      // Suppress tier escalation and proceed; log a warning so the issue remains visible.
      if (ctx.mechanicalFailedOnly) {
        logger.warn("autofix", "Mechanical-only failure unfixable — proceeding (LLM review passed)", {
          storyId: ctx.story.id,
          unresolvedReason,
        });
        if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
        return { action: "continue", cost: agentCost };
      }
      logger.warn("autofix", "Escalating due to reviewer contradiction", {
        storyId: ctx.story.id,
        unresolvedReason,
      });
      return { action: "escalate", reason: `Reviewer contradiction: ${unresolvedReason}`, cost: agentCost };
    }

    if (agentFixed) {
      if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
      // #136: Skip checks that already passed — only re-run checks that originally failed.
      // Agent rectification fixes mechanical issues (lint/typecheck); passing checks like
      // semantic (~45s) don't need to re-run unless they were the failing check.
      const passedChecks = (ctx.reviewResult?.checks ?? []).filter((c) => c.success && !c.skipped).map((c) => c.check);
      if (passedChecks.length > 0) {
        ctx.retrySkipChecks = new Set(passedChecks);
        logger.debug("autofix", "Skipping already-passed checks on retry", {
          storyId: ctx.story.id,
          skippedChecks: passedChecks,
        });
      }
      logger.info("autofix", "Agent rectification succeeded — retrying review", { storyId: ctx.story.id });
      return { action: "retry", fromStage: "review", cost: agentCost };
    }

    // Partial-progress retry: if the agent cleared at least one check this cycle but not all,
    // and the global budget has not been exhausted, retry from review with cleared checks
    // added to the skip list. The next cycle then targets only the remaining failures.
    // Zero-progress → escalate immediately (stuck rule: no point burning more budget).
    const maxTotal = ctx.config.quality.autofix?.maxTotalAttempts ?? 10;
    const totalUsed = ctx.autofixAttempt ?? 0;
    // Treat fail-open checks as still-failing so they are not added to retrySkipChecks.
    // An adversarial timeout is not a genuine pass — skipping it next cycle would let
    // the story complete without a real adversarial review. Issue #832.
    const currentlyFailing = new Set(
      (ctx.reviewResult?.checks ?? []).filter((c) => !c.success || c.failOpen).map((c) => c.check),
    );
    const nowPassing = [...failedCheckNames].filter((c) => !currentlyFailing.has(c));

    if (nowPassing.length > 0 && totalUsed < maxTotal) {
      ctx.retrySkipChecks = new Set([...(ctx.retrySkipChecks ?? []), ...nowPassing]);
      logger.info("autofix", "Partial progress — retrying review with updated skip list", {
        storyId: ctx.story.id,
        nowPassing,
        remaining: [...currentlyFailing],
        budgetUsed: `${totalUsed}/${maxTotal}`,
      });
      return { action: "retry", fromStage: "review", cost: agentCost };
    }

    logger.warn("autofix", "Autofix exhausted — escalating", { storyId: ctx.story.id });
    return {
      action: "escalate",
      reason: "Autofix exhausted: review still failing after fix attempts",
      cost: agentCost,
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function recheckReview(ctx: PipelineContext): Promise<boolean> {
  // Import reviewStage lazily to avoid circular deps
  const { reviewStage } = await import("./review");
  if (!reviewStage.enabled(ctx)) return true;
  // reviewStage.execute updates ctx.reviewResult in place.
  // We cannot use result.action here because review returns "continue" for BOTH
  // pass and built-in-check-failure (to hand off to autofix). Check success directly.
  await reviewStage.execute(ctx);
  // A fail-open result (LLM could not parse its response) is not a genuine pass in a
  // recheck context — we already know the review was failing before this call.
  const hasFailOpen = (ctx.reviewResult?.checks ?? []).some((c) => c.failOpen);
  if (hasFailOpen) return false;
  return ctx.reviewResult?.success === true;
}

/**
 * Injectable deps for testing.
 */
export const _autofixDeps = {
  runQualityCommand,
  recheckReview,
  captureGitRef,
  runAgentRectification: (
    ctx: PipelineContext,
    lintFixCmd: string | undefined,
    formatFixCmd: string | undefined,
    effectiveWorkdir: string,
  ): Promise<{ succeeded: boolean; cost: number; unresolvedReason?: string }> =>
    import("./autofix-agent").then(({ runAgentRectification }) =>
      runAgentRectification(ctx, lintFixCmd, formatFixCmd, effectiveWorkdir),
    ),
  runTestWriterRectification: (
    ctx: PipelineContext,
    testWriterChecks: ReviewCheckResult[],
    story: UserStory,
    agentManager: import("../../agents").IAgentManager,
  ): Promise<number> => runTestWriterRectification(ctx, testWriterChecks, story, agentManager),
};
