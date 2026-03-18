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
import { resolveModel } from "../../config";
import { loadConfigForWorkdir } from "../../config/loader";
import { resolvePermissions } from "../../config/permissions";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import type { ReviewCheckResult } from "../../review/types";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

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

    // Resolve per-package config (same pattern as verify.ts)
    const effectiveConfig = ctx.story.workdir
      ? await _autofixDeps.loadConfigForWorkdir(join(ctx.workdir, "nax", "config.json"), ctx.story.workdir)
      : ctx.config;

    const lintFixCmd = effectiveConfig.quality.commands.lintFix;
    const formatFixCmd = effectiveConfig.quality.commands.formatFix;

    // Effective workdir for running commands (scoped to package if monorepo)
    const effectiveWorkdir = ctx.story.workdir ? join(ctx.workdir, ctx.story.workdir) : ctx.workdir;

    // Phase 1: Mechanical fix (if commands are configured)
    if (lintFixCmd || formatFixCmd) {
      if (lintFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: lintFixCmd });
        const lintResult = await _autofixDeps.runCommand(lintFixCmd, effectiveWorkdir);
        logger.debug("autofix", `lintFix exit=${lintResult.exitCode}`, { storyId: ctx.story.id });
        if (lintResult.exitCode !== 0) {
          logger.warn("autofix", "lintFix command failed — may not have fixed all issues", {
            storyId: ctx.story.id,
            exitCode: lintResult.exitCode,
          });
        }
      }

      if (formatFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: formatFixCmd });
        const fmtResult = await _autofixDeps.runCommand(formatFixCmd, effectiveWorkdir);
        logger.debug("autofix", `formatFix exit=${fmtResult.exitCode}`, { storyId: ctx.story.id });
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
        if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
        logger.info("autofix", "Mechanical autofix succeeded — retrying review", { storyId: ctx.story.id });
        return { action: "retry", fromStage: "review" };
      }
    }

    // Phase 2: Agent rectification — spawn agent with review error context
    const agentFixed = await _autofixDeps.runAgentRectification(ctx);
    if (agentFixed) {
      if (ctx.reviewResult) ctx.reviewResult = { ...ctx.reviewResult, success: true };
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

interface CommandResult {
  exitCode: number;
  output: string;
}

async function runCommand(cmd: string, cwd: string): Promise<CommandResult> {
  const parts = cmd.split(/\s+/);
  const proc = Bun.spawn(parts, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

async function recheckReview(ctx: PipelineContext): Promise<boolean> {
  // Import reviewStage lazily to avoid circular deps
  const { reviewStage } = await import("./review");
  if (!reviewStage.enabled(ctx)) return true;
  const result = await reviewStage.execute(ctx);
  return result.action === "continue";
}

function collectFailedChecks(ctx: PipelineContext): ReviewCheckResult[] {
  return (ctx.reviewResult?.checks ?? []).filter((c) => !c.success);
}

export function buildReviewRectificationPrompt(failedChecks: ReviewCheckResult[], story: UserStory): string {
  const errors = failedChecks
    .map((c) => `## ${c.check} errors (exit code ${c.exitCode})\n\`\`\`\n${c.output}\n\`\`\``)
    .join("\n\n");

  return `You are fixing lint/typecheck errors from a code review.

Story: ${story.title} (${story.id})

The following quality checks failed after implementation:

${errors}

Fix ALL errors listed above. Do NOT change test files or test behavior.
Do NOT add new features — only fix the quality check errors.
Commit your fixes when done.`;
}

async function runAgentRectification(ctx: PipelineContext): Promise<boolean> {
  const logger = getLogger();
  const maxAttempts = ctx.config.quality.autofix?.maxAttempts ?? 2;
  const failedChecks = collectFailedChecks(ctx);

  if (failedChecks.length === 0) {
    logger.debug("autofix", "No failed checks found — skipping agent rectification", { storyId: ctx.story.id });
    return false;
  }

  logger.info("autofix", "Starting agent rectification for review failures", {
    storyId: ctx.story.id,
    failedChecks: failedChecks.map((c) => c.check),
    maxAttempts,
  });

  const agentGetFn = ctx.agentGetFn ?? getAgent;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info("autofix", `Agent rectification attempt ${attempt}/${maxAttempts}`, { storyId: ctx.story.id });

    const agent = agentGetFn(ctx.config.autoMode.defaultAgent);
    if (!agent) {
      logger.error("autofix", "Agent not found — cannot run agent rectification", { storyId: ctx.story.id });
      return false;
    }

    const prompt = buildReviewRectificationPrompt(failedChecks, ctx.story);
    const modelTier = ctx.story.routing?.modelTier ?? ctx.config.autoMode.escalation.tierOrder[0]?.tier ?? "balanced";
    const modelDef = resolveModel(ctx.config.models[modelTier]);

    await agent.run({
      prompt,
      workdir: ctx.workdir,
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
export const _autofixDeps = { runCommand, recheckReview, runAgentRectification, loadConfigForWorkdir };
