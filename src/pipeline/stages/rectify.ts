// RE-ARCH: keep
/**
 * Rectify Stage (ADR-005, Phase 2)
 *
 * Runs after a failed verify stage. Attempts to fix test failures by
 * running a rectification loop (agent + re-verify cycle).
 *
 * Enabled only when ctx.verifyResult?.success === false.
 *
 * Returns:
 * - `retry` fromStage:"verify" — rectification fixed the failures
 * - `escalate`                 — max retries exhausted
 */

import { getLogger } from "../../logger";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const rectifyStage: PipelineStage = {
  name: "rectify",

  enabled(ctx: PipelineContext): boolean {
    // Only run when verify failed
    if (!ctx.verifyResult) return false;
    if (ctx.verifyResult.success) return false;
    // Only run when rectification is enabled in config
    return ctx.config.execution.rectification?.enabled ?? false;
  },

  skipReason(ctx: PipelineContext): string {
    if (!ctx.verifyResult || ctx.verifyResult.success) return "not needed (verify passed)";
    return "disabled (rectification not enabled in config)";
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const { verifyResult } = ctx;

    if (!verifyResult || verifyResult.success) {
      return { action: "continue" };
    }

    const testOutput = verifyResult.rawOutput ?? "";
    const maxRetries = ctx.config.execution.rectification?.maxRetries ?? 3;

    logger.info("rectify", "Starting rectification loop", {
      storyId: ctx.story.id,
      failCount: verifyResult.failCount,
      maxRetries,
    });

    ctx.rectifyAttempt = (ctx.rectifyAttempt ?? 0) + 1;
    const rectifyAttempt = ctx.rectifyAttempt;

    pipelineEventBus.emit({
      type: "rectify:started",
      storyId: ctx.story.id,
      attempt: rectifyAttempt,
      testOutput,
    });

    const testCommand = ctx.config.review?.commands?.test ?? ctx.config.quality.commands.test ?? "bun test";
    const fixed = await _rectifyDeps.runRectificationLoop({
      config: ctx.config,
      workdir: ctx.workdir,
      story: ctx.story,
      testCommand,
      timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
      testOutput,
      agentGetFn: ctx.agentGetFn,
    });

    pipelineEventBus.emit({
      type: "rectify:completed",
      storyId: ctx.story.id,
      attempt: rectifyAttempt,
      fixed,
    });

    if (fixed) {
      logger.info("rectify", "Rectification succeeded — retrying verify", { storyId: ctx.story.id });
      // Clear verifyResult so verify stage re-runs fresh
      ctx.verifyResult = undefined;
      return { action: "retry", fromStage: "verify" };
    }

    logger.warn("rectify", "Rectification exhausted — escalating", { storyId: ctx.story.id });
    return {
      action: "escalate",
      reason: `Rectification exhausted after ${maxRetries} attempts (${verifyResult.failCount} test failures)`,
    };
  },
};

/**
 * Injectable deps for testing.
 */
import { runRectificationLoop } from "../../verification/rectification-loop";
export const _rectifyDeps = { runRectificationLoop };
