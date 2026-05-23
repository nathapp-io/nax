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
    // Skip when inline review is on — the orchestrator's per-story plan has already
    // run rectification inside ExecutionPlan. Running again here would re-iterate
    // the same findings and consume extra LLM calls.
    if (ctx.config.execution?.inlineReview === true) return false;
    // Only run when rectification is enabled in config
    return ctx.config.execution.rectification?.enabled ?? false;
  },

  skipReason(ctx: PipelineContext): string {
    if (!ctx.verifyResult || ctx.verifyResult.success) return "not needed (verify passed)";
    if (ctx.config.execution?.inlineReview === true) return "handled by in-story orchestrator (inlineReview=true)";
    return "disabled (rectification not enabled in config)";
  },

  async execute(ctx: PipelineContext): Promise<StageResult> {
    const logger = getLogger();
    const { verifyResult } = ctx;

    if (!verifyResult || verifyResult.success) {
      return { action: "continue" };
    }

    // If failCount is 0 but verify still failed, the process exited non-zero due
    // to an environmental issue (e.g. resource warnings, open handles, infra crash)
    // rather than test assertion failures. The agent cannot fix environmental issues
    // by changing code, so skip rectification and escalate immediately.
    if ((verifyResult.failCount ?? 0) === 0) {
      logger.warn("rectify", "Verify failed with 0 test failures — escalating without rectification", {
        storyId: ctx.story.id,
        failCount: verifyResult.failCount,
        verifyStatus: verifyResult.status,
      });
      return {
        action: "escalate",
        reason: `Verify failed with 0 test failures (status: ${verifyResult.status} — not fixable by code changes)`,
      };
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
          writtenByAgent: ctx.routing?.agent ?? ctx.agentManager?.getDefault() ?? "claude",
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
      return { action: "retry", fromStage: "verify", resetRetryCount: true, cost };
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
import { runRectificationLoop } from "../../verification/rectification-loop";
export const _rectifyDeps = {
  runRectificationLoop: (
    ctx: PipelineContext,
    opts: { testCommand: string; testOutput: string; promptPrefix?: string; testScopedTemplate?: string },
  ) =>
    runRectificationLoop({
      config: ctx.config,
      workdir: ctx.workdir,
      story: ctx.story,
      testCommand: opts.testCommand,
      timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
      testOutput: opts.testOutput,
      promptPrefix: opts.promptPrefix,
      featureName: ctx.prd.feature,
      agentManager: ctx.agentManager,
      projectDir: ctx.projectDir,
      testScopedTemplate: opts.testScopedTemplate,
      runtime: ctx.runtime,
      sessionId: ctx.sessionId,
    }),
  resolveTestCommands: resolveQualityTestCommands,
  appendScratch: appendScratchEntry,
};
