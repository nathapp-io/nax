/**
 * Runner Completion Phase
 *
 * Handles post-execution steps: acceptance loop, hooks, metrics, and cleanup.
 * Extracted from runner.ts for better code organization.
 */

import path from "node:path";
import { groupStoriesByPackage } from "@/acceptance";
import { type NaxConfig, loadConfigForWorkdir } from "@/config";
import type { LoadedHooksConfig } from "@/hooks";
import { fireHook } from "@/hooks";
import { getSafeLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import { pipelineEventBus } from "@/pipeline";
import type { PipelineEventEmitter } from "@/pipeline/events";
import type { AgentGetFn } from "@/pipeline/types";
import type { PluginRegistry } from "@/plugins/registry";
import { isComplete } from "@/prd";
import type { PRD } from "@/prd";
import type { DispatchContext } from "@/runtime/dispatch-context";
import type { ISessionManager } from "@/session";
import { errorMessage } from "@/utils/errors";
import { autoCommitIfDirty } from "@/utils/git";
import { stopHeartbeat, writeExitSummary } from "./crash-recovery";
import type { DeferredReviewResult } from "./deferred-review";
import type { ExitReason } from "./executor-types";
import type { AcceptanceLoopContext, AcceptanceLoopResult } from "./lifecycle/acceptance-loop";
import type { RunCompletionOptions, RunCompletionResult } from "./lifecycle/run-completion";
import { hookCtx } from "./story-context";

/**
 * Options for the completion phase.
 */
export interface RunnerCompletionOptions extends DispatchContext {
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  workdir: string;
  statusFile: string;
  logFilePath?: string;
  runId: string;
  startedAt: string;
  startTime: number;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
  headless: boolean;
  featureDir?: string;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
  totalCost: number;
  storiesCompleted: number;
  iterations: number;
  // biome-ignore lint/suspicious/noExplicitAny: StatusWriter interface varies by platform
  statusWriter: any;
  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  /** Protocol-aware agent resolver */
  agentGetFn?: AgentGetFn;
  /** Path to prd.json — required for acceptance fix story writes */
  prdPath: string;
  /** Per-run plugin-provider cache (Finding 5 / issue #473). Disposed in handleRunCompletion. */
  pluginProviderCache?: import("../context/engine").PluginProviderCache;
  /** End-of-run deferred plugin review result (#1146 G2). Forwarded to handleRunCompletion. */
  deferredReview?: DeferredReviewResult;
  /** Why the execution phase stopped — used to distinguish a cost-limit stop from a normal completion. */
  exitReason?: ExitReason;
}

/**
 * Result from the completion phase.
 */
export interface RunnerCompletionResult {
  durationMs: number;
  runCompletedAt: string;
  /** False when the acceptance loop exhausted retries for any package. True when acceptance
   *  passed, was skipped, or was already passed on a prior run. Used by runner.ts to set
   *  RunResult.success — regression-gate outcome cannot override an acceptance failure. */
  acceptancePassed: boolean;
  /** True when a gating-mode deferred plugin reviewer failed. Factored into RunResult.success. */
  pluginGateFailed: boolean;
}

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runnerCompletionDeps: {
  runAcceptanceLoop(ctx: AcceptanceLoopContext): Promise<AcceptanceLoopResult>;
  handleRunCompletion(opts: RunCompletionOptions): Promise<RunCompletionResult>;
  loadConfigForWorkdir(rootConfigPath: string, workdir?: string): Promise<NaxConfig>;
} = {
  async runAcceptanceLoop(ctx) {
    const { runAcceptanceLoop } = await import("./lifecycle/acceptance-loop");
    return runAcceptanceLoop(ctx);
  },
  async handleRunCompletion(opts) {
    const { handleRunCompletion } = await import("./lifecycle/run-completion");
    return handleRunCompletion(opts);
  },
  loadConfigForWorkdir,
};

/**
 * Execute the completion phase of the run.
 *
 * @param options - Completion options
 * @returns Completion result
 */
export async function runCompletionPhase(options: RunnerCompletionOptions): Promise<RunnerCompletionResult> {
  const logger = getSafeLogger();

  logger?.debug("execution", "Completion phase started", {
    acceptanceEnabled: options.config.acceptance?.enabled,
    isComplete: isComplete(options.prd),
  });

  // Track whether acceptance passed (or was skipped/already-passed) — surfaced in
  // RunnerCompletionResult so runner.ts can include it in RunResult.success.
  let acceptancePassed = true;

  // Check post-run status to determine if phases can be skipped on rerun
  const postRunStatus = options.statusWriter.getPostRunStatus?.();
  const acceptanceAlreadyPassed = postRunStatus?.acceptance?.status === "passed";
  const regressionAlreadyPassed = postRunStatus?.regression?.status === "passed";

  if (acceptanceAlreadyPassed && regressionAlreadyPassed) {
    logger?.info("execution", "Post-run phases already passed — skipping acceptance and regression");
  } else {
    if (acceptanceAlreadyPassed) {
      logger?.info("execution", "Acceptance already passed — skipping acceptance phase");
    } else if (options.config.acceptance.enabled && isComplete(options.prd)) {
      options.statusWriter.setPostRunPhase("acceptance", { status: "running" });
      pipelineEventBus.emit({ type: "postrun:phase:started", phase: "acceptance" });

      // Compute per-package acceptance test paths from PRD story workdirs.
      // This is necessary because preRunCtx.acceptanceTestPaths is ephemeral and
      // not propagated here; it's also skipped entirely when the PRD is already
      // complete at run start (re-run). groupStoriesByPackage is the SSOT.
      const acceptanceTestPaths = options.featureDir
        ? await Promise.all(
            (
              await groupStoriesByPackage(
                options.prd,
                options.workdir,
                options.feature,
                options.config.acceptance.testPath,
                options.config.project?.language,
              )
            ).map(async (g) => {
              const relativeWorkdir = path.relative(options.workdir, g.packageDir);
              let groupConfig = options.config;

              if (relativeWorkdir && relativeWorkdir !== ".") {
                try {
                  groupConfig = await _runnerCompletionDeps.loadConfigForWorkdir(
                    path.join(options.workdir, ".nax", "config.json"),
                    relativeWorkdir,
                  );
                } catch (error) {
                  logger?.warn("execution", "Falling back to root config for package acceptance settings", {
                    packageDir: g.packageDir,
                    relativeWorkdir,
                    error: errorMessage(error),
                  });
                }
              }

              return {
                testPath: g.testPath,
                packageDir: g.packageDir,
                testFramework: groupConfig.project?.testFramework,
                commandOverride: groupConfig.acceptance.command,
              };
            }),
          )
        : undefined;

      const acceptanceResult = await _runnerCompletionDeps.runAcceptanceLoop({
        config: options.config,
        prd: options.prd,
        prdPath: options.prdPath,
        workdir: options.workdir,
        featureDir: options.featureDir,
        hooks: options.hooks,
        feature: options.feature,
        totalCost: options.totalCost,
        iterations: options.iterations,
        storiesCompleted: options.storiesCompleted,
        allStoryMetrics: options.allStoryMetrics,
        pluginRegistry: options.pluginRegistry,
        eventEmitter: options.eventEmitter,
        statusWriter: options.statusWriter,
        agentGetFn: options.agentGetFn,
        agentManager: options.agentManager,
        sessionManager: options.sessionManager,
        runtime: options.runtime,
        abortSignal: options.abortSignal,
        acceptanceTestPaths,
      });

      const lastRunAt = new Date().toISOString();
      if (acceptanceResult.success) {
        options.statusWriter.setPostRunPhase("acceptance", { status: "passed", lastRunAt });
        pipelineEventBus.emit({ type: "postrun:phase:completed", phase: "acceptance", passed: true });
      } else {
        acceptancePassed = false;
        options.statusWriter.setPostRunPhase("acceptance", {
          status: "failed",
          failedACs: acceptanceResult.failedACs ?? [],
          retries: acceptanceResult.retries ?? 0,
          lastRunAt,
        });
        pipelineEventBus.emit({ type: "postrun:phase:completed", phase: "acceptance", passed: false });
      }

      Object.assign(options, {
        prd: acceptanceResult.prd,
        totalCost: acceptanceResult.totalCost,
        iterations: acceptanceResult.iterations,
        storiesCompleted: acceptanceResult.storiesCompleted,
      });
    }
  }

  // Fire on-all-stories-complete before regression gate (RL-001)
  if (isComplete(options.prd)) {
    await fireHook(
      options.hooks,
      "on-all-stories-complete",
      hookCtx(options.feature, { status: "passed", cost: options.totalCost }),
      options.workdir,
    );
  }

  // Handle run completion: save metrics, log summary, update status
  const completionResult = await _runnerCompletionDeps.handleRunCompletion({
    runId: options.runId,
    feature: options.feature,
    startedAt: options.startedAt,
    prd: options.prd,
    allStoryMetrics: options.allStoryMetrics,
    totalCost: options.totalCost,
    storiesCompleted: options.storiesCompleted,
    iterations: options.iterations,
    startTime: options.startTime,
    workdir: options.workdir,
    statusWriter: options.statusWriter,
    config: options.config,
    agentManager: options.agentManager,
    skipRegression: regressionAlreadyPassed,
    sessionManager: options.sessionManager,
    pluginProviderCache: options.pluginProviderCache,
    deferredReview: options.deferredReview,
    exitReason: options.exitReason,
    runtime: options.runtime,
    abortSignal: options.abortSignal,
  });

  const { durationMs, runCompletedAt, finalCounts, reportedTotal, pluginGateFailed } = completionResult;

  // Write feature-level status (SFC-002).
  // Use reportedTotal (cost-aggregator-corrected) instead of the legacy
  // options.totalCost accumulator, which drops acceptance/review/diagnosis
  // spend (issue #909).
  if (options.featureDir) {
    // A gating-mode plugin reviewer failure fails the run even when all stories passed
    // (#1146 G2). Folded in here — not via setRunStatus inside handleRunCompletion, which
    // this line would otherwise clobber back to "completed".
    // pluginGateFailed is checked first so a genuine gate failure is never masked by a
    // cost-limit stop — the budget being hit doesn't make a reviewer failure less real.
    const finalStatus = pluginGateFailed
      ? "failed"
      : options.exitReason === "cost-limit"
        ? "cost-limit"
        : isComplete(options.prd)
          ? "completed"
          : "failed";
    options.statusWriter.setRunStatus(finalStatus);
    await options.statusWriter.writeFeatureStatus(options.featureDir, reportedTotal, options.iterations);
  }

  // §2.1 — surface non-blocking (sub-threshold) review findings accumulated this run.
  // Without this, real findings below `blockingThreshold` are only visible in a
  // per-story debug log line and the on-disk `.nax/review-audit/` trail.
  const advisoryFindings = options.runtime?.reviewAuditor?.getAdvisoryFindings() ?? [];
  if (advisoryFindings.length > 0) {
    logger?.warn("review", `${advisoryFindings.length} non-blocking review finding(s) surfaced at run end`, {
      storyId: "_run",
      count: advisoryFindings.length,
      findings: advisoryFindings,
    });
  }

  // Output run footer in headless mode
  if (options.headless && options.formatterMode !== "json") {
    const { outputAdvisoryFindingsSummary, outputRunFooter } = await import("./lifecycle/headless-formatter");
    outputAdvisoryFindingsSummary(advisoryFindings, options.formatterMode);
    outputRunFooter({
      finalCounts: {
        total: finalCounts.total,
        passed: finalCounts.passed,
        failed: finalCounts.failed,
        skipped: finalCounts.skipped,
      },
      durationMs,
      totalCost: reportedTotal,
      startedAt: options.startedAt,
      completedAt: runCompletedAt,
      formatterMode: options.formatterMode,
    });
  }

  // Stop heartbeat and write exit summary (US-007)
  logger?.debug("execution", "Completion phase — stopping heartbeat and writing exit summary");
  stopHeartbeat();
  await writeExitSummary(options.logFilePath, reportedTotal, options.iterations, options.storiesCompleted, durationMs);

  // Commit status.json and any other nax runtime files left dirty at run end
  logger?.debug("execution", "Completion phase — auto-committing dirty files");
  await autoCommitIfDirty(options.workdir, "run.complete", "run-summary", options.feature);

  // Close the NaxRuntime — flushes auditors, drains cost aggregator, aborts signal
  await options.runtime?.close();

  logger?.debug("execution", "Completion phase done — returning to runner");

  return {
    durationMs,
    runCompletedAt,
    acceptancePassed,
    pluginGateFailed,
  };
}
