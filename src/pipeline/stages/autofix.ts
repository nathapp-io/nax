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

import { join } from "node:path";
import { getAgent } from "../../agents";
import { resolveModelForAgent } from "../../config";
import { loadConfigForWorkdir } from "../../config/loader";
import { resolvePermissions } from "../../config/permissions";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { runQualityCommand } from "../../quality";
import type { ReviewCheckResult } from "../../review/types";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const autofixStage: PipelineStage = {
  name: "autofix",

  enabled(ctx: PipelineContext): boolean {
    if (!ctx.reviewResult) return false;
    if (ctx.reviewResult.success) return false;
    const autofixEnabled = (ctx.effectiveConfig ?? ctx.config).quality.autofix?.enabled ?? true;
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

    // PKG-004: use centrally resolved effective config (ctx.effectiveConfig set once per story)
    const effectiveConfig = ctx.effectiveConfig ?? ctx.config;
    const lintFixCmd = effectiveConfig.quality.commands.lintFix;
    const formatFixCmd = effectiveConfig.quality.commands.formatFix;

    // Effective workdir for running commands (scoped to package if monorepo)
    const effectiveWorkdir = ctx.story.workdir ? join(ctx.workdir, ctx.story.workdir) : ctx.workdir;

    // Identify which checks failed
    const failedCheckNames = new Set((reviewResult.checks ?? []).filter((c) => !c.success).map((c) => c.check));
    const hasLintFailure = failedCheckNames.has("lint");

    logger.info("autofix", "Starting autofix", {
      storyId: ctx.story.id,
      failedChecks: [...failedCheckNames],
      workdir: effectiveWorkdir,
    });

    // Phase 1: Mechanical fix — only for lint failures (lintFix/formatFix cannot fix typecheck errors)
    if (hasLintFailure && (lintFixCmd || formatFixCmd)) {
      if (lintFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: lintFixCmd });
        const lintResult = await _autofixDeps.runQualityCommand({
          commandName: "lintFix",
          command: lintFixCmd,
          workdir: effectiveWorkdir,
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
          workdir: effectiveWorkdir,
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
        logger.info("autofix", "Mechanical autofix succeeded — retrying review", { storyId: ctx.story.id });
        return { action: "retry", fromStage: "review" };
      }

      logger.info("autofix", "Mechanical autofix did not resolve all failures — proceeding to agent rectification", {
        storyId: ctx.story.id,
      });
    }

    // Phase 2: Agent rectification — spawn agent with review error context
    const agentFixed = await _autofixDeps.runAgentRectification(ctx);
    if (agentFixed) {
      if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
      // #136: Skip checks that already passed — only re-run checks that originally failed.
      // Agent rectification fixes mechanical issues (lint/typecheck); passing checks like
      // semantic (~45s) don't need to re-run unless they were the failing check.
      const passedChecks = (ctx.reviewResult?.checks ?? []).filter((c) => c.success).map((c) => c.check);
      if (passedChecks.length > 0) {
        ctx.retrySkipChecks = new Set(passedChecks);
        logger.debug("autofix", "Skipping already-passed checks on retry", {
          storyId: ctx.story.id,
          skippedChecks: passedChecks,
        });
      }
      logger.info("autofix", "Agent rectification succeeded — retrying review", { storyId: ctx.story.id });
      return { action: "retry", fromStage: "review" };
    }

    logger.warn("autofix", "Autofix exhausted — escalating", { storyId: ctx.story.id });
    return { action: "escalate", reason: "Autofix exhausted: review still failing after fix attempts" };
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
  return ctx.reviewResult?.success === true;
}

function collectFailedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return (ctx.reviewResult?.checks ?? []).filter((c) => !c.success);
}

export function buildReviewRectificationPrompt(failedChecks: ReviewCheckResult[], story: UserStory): string {
  const errors = failedChecks
    .map((c) => `## ${c.check} errors (exit code ${c.exitCode})\n\`\`\`\n${c.output}\n\`\`\``)
    .join("\n\n");

  // ENH-008: Scope constraint for monorepo stories — prevent out-of-package changes
  const scopeConstraint = story.workdir
    ? `\n\nIMPORTANT: Only modify files within \`${story.workdir}/\`. Do NOT touch files outside this directory.`
    : "";

  return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

Fix ALL errors listed above. Do NOT change test files or test behavior.
Do NOT add new features — only fix the quality check errors.
Commit your fixes when done.${scopeConstraint}`;
}

async function runAgentRectification(ctx: PipelineContext): Promise<boolean> {
  const logger = getLogger();
  const effectiveConfig = ctx.effectiveConfig ?? ctx.config;
  const maxPerCycle = effectiveConfig.quality.autofix?.maxAttempts ?? 2;
  const maxTotal = effectiveConfig.quality.autofix?.maxTotalAttempts ?? 10;
  const consumed = ctx.autofixAttempt ?? 0;
  const failedChecks = collectFailedChecks(ctx);

  if (failedChecks.length === 0) {
    logger.debug("autofix", "No failed checks found — skipping agent rectification", { storyId: ctx.story.id });
    return false;
  }

  // Global budget check — escalate if total attempts exhausted across all cycles
  if (consumed >= maxTotal) {
    logger.warn("autofix", "Global autofix budget exhausted — escalating", {
      storyId: ctx.story.id,
      totalAttempts: consumed,
      maxTotalAttempts: maxTotal,
    });
    return false;
  }

  // Cap this cycle's attempts to not exceed global budget
  const remainingBudget = maxTotal - consumed;
  const maxAttempts = Math.min(maxPerCycle, remainingBudget);

  logger.info("autofix", "Starting agent rectification for review failures", {
    storyId: ctx.story.id,
    failedChecks: failedChecks.map((c) => c.check),
    maxAttempts,
    totalUsed: consumed,
    maxTotalAttempts: maxTotal,
  });

  const agentGetFn = ctx.agentGetFn ?? _autofixDeps.getAgent;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    ctx.autofixAttempt = consumed + attempt;
    logger.info("autofix", `Agent rectification attempt ${ctx.autofixAttempt}/${maxTotal}`, { storyId: ctx.story.id });

    const agent = agentGetFn(ctx.config.autoMode.defaultAgent);
    if (!agent) {
      logger.error("autofix", "Agent not found — cannot run agent rectification", { storyId: ctx.story.id });
      return false;
    }

    const prompt = buildReviewRectificationPrompt(failedChecks, ctx.story);
    const modelTier = ctx.story.routing?.modelTier ?? ctx.config.autoMode.escalation.tierOrder[0]?.tier ?? "balanced";
    const modelDef = resolveModelForAgent(
      ctx.config.models,
      ctx.routing.agent ?? ctx.config.autoMode.defaultAgent,
      modelTier,
      ctx.config.autoMode.defaultAgent,
    );

    // ENH-008: Scope agent to story.workdir for monorepo — prevents out-of-package changes
    const rectificationWorkdir = ctx.story.workdir ? join(ctx.workdir, ctx.story.workdir) : ctx.workdir;

    await agent.run({
      prompt,
      workdir: rectificationWorkdir,
      modelTier,
      modelDef,
      timeoutSeconds: ctx.config.execution.sessionTimeoutSeconds,
      dangerouslySkipPermissions: resolvePermissions(ctx.config, "rectification").skipPermissions,
      pipelineStage: "rectification",
      config: ctx.config,
      maxInteractionTurns: ctx.config.agent?.maxInteractionTurns,
      storyId: ctx.story.id,
      sessionRole: "implementer",
    });

    const passed = await _autofixDeps.recheckReview(ctx);
    if (passed) {
      logger.info("autofix", `[OK] Agent rectification succeeded on attempt ${attempt}`, {
        storyId: ctx.story.id,
      });
      return true;
    }

    // Refresh failed checks for next attempt
    const updatedFailed = collectFailedChecks(ctx);
    if (updatedFailed.length > 0) {
      failedChecks.splice(0, failedChecks.length, ...updatedFailed);
    }

    logger.warn("autofix", `Agent rectification still failing after attempt ${attempt}`, {
      storyId: ctx.story.id,
    });
  }

  logger.warn("autofix", "Agent rectification exhausted", { storyId: ctx.story.id });
  return false;
}

/**
 * Injectable deps for testing.
 */
export const _autofixDeps = {
  getAgent,
  runQualityCommand,
  recheckReview,
  runAgentRectification,
  loadConfigForWorkdir,
};
