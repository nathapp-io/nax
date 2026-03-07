// RE-ARCH: keep
/**
 * Autofix Stage (ADR-005, Phase 2)
 *
 * Runs after a failed review stage. Attempts to fix quality issues
 * automatically (lint, format) before escalating.
 *
 * Language-agnostic: uses quality.commands.lintFix / formatFix from config.
 * No hardcoded tool names.
 *
 * Enabled only when ctx.reviewResult?.passed === false AND autofix is enabled.
 *
 * Returns:
 * - `retry` fromStage:"review" — autofix resolved the failures
 * - `escalate`                 — max attempts exhausted or no fix commands
 */

import { getLogger } from "../../logger";
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

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const { reviewResult } = ctx;

    if (!reviewResult || reviewResult.success) {
      return { action: "continue" };
    }

    const lintFixCmd = ctx.config.quality.commands.lintFix;
    const formatFixCmd = ctx.config.quality.commands.formatFix;

    if (!lintFixCmd && !formatFixCmd) {
      logger.debug("autofix", "No fix commands configured — skipping autofix", { storyId: ctx.story.id });
      return { action: "escalate", reason: "Review failed and no autofix commands configured" };
    }

    const maxAttempts = ctx.config.quality.autofix?.maxAttempts ?? 2;
    let fixed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info("autofix", `Autofix attempt ${attempt}/${maxAttempts}`, { storyId: ctx.story.id });

      // Step 1: lint fix
      if (lintFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: lintFixCmd });
        const lintResult = await _autofixDeps.runCommand(lintFixCmd, ctx.workdir);
        logger.debug("autofix", `lintFix exit=${lintResult.exitCode}`, { storyId: ctx.story.id });
        if (lintResult.exitCode !== 0) {
          logger.warn("autofix", "lintFix command failed — may not have fixed all issues", {
            storyId: ctx.story.id,
            exitCode: lintResult.exitCode,
          });
        }
      }

      // Step 2: format fix
      if (formatFixCmd) {
        pipelineEventBus.emit({ type: "autofix:started", storyId: ctx.story.id, command: formatFixCmd });
        const fmtResult = await _autofixDeps.runCommand(formatFixCmd, ctx.workdir);
        logger.debug("autofix", `formatFix exit=${fmtResult.exitCode}`, { storyId: ctx.story.id });
        if (fmtResult.exitCode !== 0) {
          logger.warn("autofix", "formatFix command failed — may not have fixed all issues", {
            storyId: ctx.story.id,
            exitCode: fmtResult.exitCode,
          });
        }
      }

      // Re-run review to check if fixed
      const recheckPassed = await _autofixDeps.recheckReview(ctx);
      pipelineEventBus.emit({ type: "autofix:completed", storyId: ctx.story.id, fixed: recheckPassed });

      if (recheckPassed) {
        // Update ctx.reviewResult so downstream stages see the corrected state
        if (ctx.reviewResult) {
          ctx.reviewResult = { ...ctx.reviewResult, success: true };
        }
        fixed = true;
        break;
      }
    }

    if (fixed) {
      logger.info("autofix", "Autofix succeeded — retrying review", { storyId: ctx.story.id });
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
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, output: `${stdout}\n${stderr}` };
}

async function recheckReview(ctx: PipelineContext): Promise<boolean> {
  // Import reviewStage lazily to avoid circular deps
  const { reviewStage } = await import("./review");
  if (!reviewStage.enabled(ctx)) return true;
  const result = await reviewStage.execute(ctx);
  return result.action === "continue";
}

/**
 * Injectable deps for testing.
 */
export const _autofixDeps = { runCommand, recheckReview };
