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
import { resolveQualityTestCommands } from "../../quality/command-resolver";
import { appendScratchEntry } from "../../session/scratch-writer";
import { errorMessage } from "../../utils/errors";
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

    // Resolve test commands via SSOT — handles priority, {{package}}, and orchestrator promotion.
    const { testCommand: effectiveTestCommand, testScopedTemplate } = await _rectifyDeps.resolveTestCommands(
      ctx.config,
      ctx.workdir,
      ctx.story.workdir,
    );

    const { succeeded, cost } = await _rectifyDeps.runRectificationLoop(ctx, {
      testCommand: effectiveTestCommand ?? "bun test",
      testOutput,
      testScopedTemplate,
    });

    pipelineEventBus.emit({
      type: "rectify:completed",
      storyId: ctx.story.id,
      attempt: rectifyAttempt,
      fixed: succeeded,
    });

    // Phase 1: append rectification attempt to session scratch
    if (ctx.config.context?.v2?.enabled && ctx.sessionScratchDir) {
      try {
        await _rectifyDeps.appendScratch(ctx.sessionScratchDir, {
          kind: "rectify-attempt",
          timestamp: new Date().toISOString(),
          storyId: ctx.story.id,
          stage: "rectify",
          attempt: rectifyAttempt,
          succeeded,
        });
      } catch (scratchErr) {
        logger.warn("rectify", "Failed to write scratch entry — continuing", {
          storyId: ctx.story.id,
          error: errorMessage(scratchErr),
        });
      }
    }

    if (succeeded) {
      logger.info("rectify", "Rectification succeeded — retrying verify", { storyId: ctx.story.id });
      // Clear verifyResult so verify stage re-runs fresh
      ctx.verifyResult = undefined;
      return { action: "retry", fromStage: "verify", cost };
    }

    logger.warn("rectify", "Rectification exhausted — escalating", { storyId: ctx.story.id });
    return {
      action: "escalate",
      reason: `Rectification exhausted after ${maxRetries} attempts (${verifyResult.failCount} test failures)`,
      cost,
    };
  },
};

/**
 * Injectable deps for testing.
 */
import { runRectificationLoopFromCtx } from "../../verification/rectification-loop";
export const _rectifyDeps = {
  runRectificationLoop: runRectificationLoopFromCtx,
  resolveTestCommands: resolveQualityTestCommands,
  appendScratch: appendScratchEntry,
};
