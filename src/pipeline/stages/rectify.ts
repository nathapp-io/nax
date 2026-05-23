// RE-ARCH: keep
/**
 * Rectify Stage (ADR-005, Phase 2)
 *
 * Runs after a failed verify stage. Attempts to fix test failures by
 * running a fix cycle (agent + re-verify cycle).
 *
 * Enabled only when ctx.verifyResult?.success === false.
 *
 * Returns:
 * - `retry` fromStage:"verify" — rectification fixed the failures
 * - `escalate`                 — max retries exhausted
 */

import { getLogger } from "../../logger";
import { getExpectedFiles } from "../../prd";
import { resolveQualityTestCommands } from "../../quality/command-resolver";
import { appendScratchEntry } from "../../session/scratch-writer";
import { parseTestOutput } from "../../test-runners";
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
    const { testCommand: effectiveTestCommand } = await _rectifyDeps.resolveTestCommands(
      ctx.config,
      ctx.workdir,
      ctx.story.workdir,
    );

    const testCommand = effectiveTestCommand ?? "bun test";

    // Build initial findings from failing test output
    const initialFindings = testSummaryToFindings(parseTestOutput(testOutput));

    // Build the FixCycleContext
    const packageView = ctx.packageView ?? ctx.runtime.packages.repo();
    const cycleCtx: FixCycleContext = {
      runtime: ctx.runtime,
      packageView,
      packageDir: ctx.workdir,
      storyId: ctx.story.id,
      featureName: ctx.prd.feature,
      agentName: ctx.agentManager?.getDefault() ?? "claude",
      story: ctx.story,
    };

    const verifyOpts = {
      workdir: ctx.workdir,
      expectedFiles: getExpectedFiles(ctx.story),
      command: testCommand,
      timeoutSeconds: ctx.config.execution.verificationTimeoutSeconds,
      forceExit: ctx.config.quality.forceExit,
      detectOpenHandles: ctx.config.quality.detectOpenHandles,
      detectOpenHandlesRetries: ctx.config.quality.detectOpenHandlesRetries,
      timeoutRetryCount: 0 as const,
      gracePeriodMs: ctx.config.quality.gracePeriodMs,
      drainTimeoutMs: ctx.config.quality.drainTimeoutMs,
      shell: ctx.config.quality.shell,
      stripEnvVars: ctx.config.quality.stripEnvVars,
    };

    const cycle: FixCycle<Finding> = {
      findings: initialFindings,
      iterations: [],
      strategies: [makeFullSuiteRectifyStrategy(ctx.story)],
      config: { maxAttemptsTotal: maxRetries, validatorRetries: 1 },
      validate: async (_cycleCtx, _opts) => {
        const verification = await _rectifyDeps.runVerification(verifyOpts);
        if (verification.success) return [];
        if (verification.output) return testSummaryToFindings(parseTestOutput(verification.output));
        return initialFindings;
      },
    };

    const cycleResult = await _rectifyDeps.runFixCycle(cycle, cycleCtx, "rectify");
    const succeeded = cycleResult.exitReason === "resolved";
    const cost = cycleResult.costUsd;

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
import { runFixCycle } from "../../findings";
import type { FixCycle, FixCycleContext, FixCycleResult } from "../../findings";
import type { Finding } from "../../findings";
import { testSummaryToFindings } from "../../findings";
import { makeFullSuiteRectifyStrategy } from "../../operations";
import { fullSuite } from "../../verification";
export const _rectifyDeps = {
  runFixCycle: (
    cycle: FixCycle<Finding>,
    ctx: FixCycleContext,
    name: string,
  ): Promise<FixCycleResult<Finding>> => runFixCycle(cycle, ctx, name),
  runVerification: fullSuite,
  resolveTestCommands: resolveQualityTestCommands,
  appendScratch: appendScratchEntry,
};
