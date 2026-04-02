/**
 * Runner Completion Phase
 *
 * Handles post-execution steps: acceptance loop, hooks, metrics, and cleanup.
 * Extracted from runner.ts for better code organization.
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { AgentGetFn } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import { isComplete } from "../prd";
import type { PRD } from "../prd";
import { autoCommitIfDirty } from "../utils/git";
import { stopHeartbeat, writeExitSummary } from "./crash-recovery";
import { hookCtx } from "./story-context";

/**
 * Options for the completion phase.
 */
export interface RunnerCompletionOptions {
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
}

/**
 * Result from the completion phase.
 */
export interface RunnerCompletionResult {
  durationMs: number;
  runCompletedAt: string;
}

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

  // Check if we need acceptance retry loop
  if (options.config.acceptance.enabled && isComplete(options.prd)) {
    const { runAcceptanceLoop } = await import("./lifecycle/acceptance-loop");
    const acceptanceResult = await runAcceptanceLoop({
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
    });

    Object.assign(options, {
      prd: acceptanceResult.prd,
      totalCost: acceptanceResult.totalCost,
      iterations: acceptanceResult.iterations,
      storiesCompleted: acceptanceResult.storiesCompleted,
    });
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
  const { handleRunCompletion } = await import("./lifecycle/run-completion");
  const completionResult = await handleRunCompletion({
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
    agentGetFn: options.agentGetFn,
  });

  const { durationMs, runCompletedAt, finalCounts } = completionResult;

  // Write feature-level status (SFC-002)
  if (options.featureDir) {
    const finalStatus = isComplete(options.prd) ? "completed" : "failed";
    options.statusWriter.setRunStatus(finalStatus);
    await options.statusWriter.writeFeatureStatus(options.featureDir, options.totalCost, options.iterations);
  }

  // Output run footer in headless mode
  if (options.headless && options.formatterMode !== "json") {
    const { outputRunFooter } = await import("./lifecycle/headless-formatter");
    outputRunFooter({
      finalCounts: {
        total: finalCounts.total,
        passed: finalCounts.passed,
        failed: finalCounts.failed,
        skipped: finalCounts.skipped,
      },
      durationMs,
      totalCost: options.totalCost,
      startedAt: options.startedAt,
      completedAt: runCompletedAt,
      formatterMode: options.formatterMode,
    });
  }

  // Stop heartbeat and write exit summary (US-007)
  logger?.debug("execution", "Completion phase — stopping heartbeat and writing exit summary");
  stopHeartbeat();
  await writeExitSummary(
    options.logFilePath,
    options.totalCost,
    options.iterations,
    options.storiesCompleted,
    durationMs,
  );

  // Commit status.json and any other nax runtime files left dirty at run end
  logger?.debug("execution", "Completion phase — auto-committing dirty files");
  await autoCommitIfDirty(options.workdir, "run.complete", "run-summary", options.feature);
  logger?.debug("execution", "Completion phase done — returning to runner");

  return {
    durationMs,
    runCompletedAt,
  };
}
