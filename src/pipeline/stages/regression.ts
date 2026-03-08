// RE-ARCH: keep
/**
 * Regression Stage (ADR-005, Phase 2)
 *
 * Runs a full-suite regression gate as part of the per-story pipeline,
 * when regressionGate.mode === "per-story" AND verify passed.
 *
 * This replaces the per-story regression gate previously handled in
 * src/execution/post-verify.ts (which will be deleted in Phase 4).
 *
 * Returns:
 * - `continue`  — full suite passed
 * - `escalate`  — full suite failed after optional rectification
 */

import { getLogger } from "../../logger";
import { verificationOrchestrator } from "../../verification/orchestrator";
import type { VerifyContext } from "../../verification/orchestrator-types";
import { pipelineEventBus } from "../event-bus";
import type { PipelineContext, PipelineStage, StageResult } from "../types";

export const regressionStage: PipelineStage = {
  name: "regression",

  enabled(ctx: PipelineContext): boolean {
    const mode = ctx.config.execution.regressionGate?.mode ?? "deferred";
    if (mode !== "per-story") return false;
    // Only run when verify passed (or was skipped/not set)
    if (ctx.verifyResult && !ctx.verifyResult.success) return false;
    const gateEnabled = ctx.config.execution.regressionGate?.enabled ?? true;
    return gateEnabled;
  },

  skipReason(ctx: PipelineContext): string {
    const mode = ctx.config.execution.regressionGate?.mode ?? "deferred";
    if (mode !== "per-story") return `not needed (regression mode is '${mode}', not 'per-story')`;
    return "disabled (regression gate not enabled in config)";
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const testCommand = ctx.config.review?.commands?.test ?? ctx.config.quality.commands.test ?? "bun test";
    const timeoutSeconds = ctx.config.execution.regressionGate?.timeoutSeconds ?? 120;

    logger.info("regression", "Running full-suite regression gate", { storyId: ctx.story.id });

    const verifyCtx: VerifyContext = {
      workdir: ctx.workdir,
      testCommand,
      timeoutSeconds,
      storyId: ctx.story.id,
      acceptOnTimeout: ctx.config.execution.regressionGate?.acceptOnTimeout ?? true,
      config: ctx.config,
    };

    const result = await _regressionStageDeps.verifyRegression(verifyCtx);

    pipelineEventBus.emit({ type: "verify:completed", storyId: ctx.story.id, result });

    if (result.success) {
      logger.info("regression", "Full-suite regression gate passed", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    if (result.status === "TIMEOUT") {
      logger.warn("regression", "Regression gate timed out (accepted as pass)", { storyId: ctx.story.id });
      return { action: "continue" };
    }

    logger.warn("regression", "Full-suite regression detected", {
      storyId: ctx.story.id,
      failCount: result.failCount,
    });

    pipelineEventBus.emit({
      type: "regression:detected",
      storyId: ctx.story.id,
      failedTests: result.failCount,
    });

    return {
      action: "escalate",
      reason: `Full-suite regression: ${result.failCount} test(s) failing`,
    };
  },
};

/**
 * Injectable deps for testing.
 */
export const _regressionStageDeps = {
  verifyRegression: (ctx: VerifyContext) => verificationOrchestrator.verifyRegression(ctx),
};
