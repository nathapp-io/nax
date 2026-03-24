/**
 * Runner Execution Phase
 *
 * Handles parallel and sequential story execution paths.
 * Extracted from runner.ts for better code organization.
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { AgentGetFn } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD } from "../prd";
import { tryLlmBatchRoute } from "../routing";
import { clearCache as clearLlmCache } from "../routing/strategies/llm";
import { precomputeBatchPlan } from "./batching";
import { getAllReadyStories } from "./helpers";
import type { ParallelExecutorOptions, ParallelExecutorResult } from "./parallel-executor";
import type { PidRegistry } from "./pid-registry";

/**
 * Options for the execution phase.
 */
export interface RunnerExecutionOptions {
  prdPath: string;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  featureDir?: string;
  dryRun: boolean;
  useBatch: boolean;
  eventEmitter?: PipelineEventEmitter;
  // biome-ignore lint/suspicious/noExplicitAny: StatusWriter interface varies by platform
  statusWriter: any;
  statusFile: string;
  logFilePath?: string;
  runId: string;
  startedAt: string;
  startTime: number;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
  headless: boolean;
  parallel?: number;
  runParallelExecution?: (options: ParallelExecutorOptions, prd: PRD) => Promise<ParallelExecutorResult>;
  /** Protocol-aware agent resolver — created once in runner.ts from createAgentRegistry(config) */
  agentGetFn?: AgentGetFn;
  /** PID registry for crash recovery — passed to agent.run() to register child processes. */
  pidRegistry?: PidRegistry;
}

/**
 * Result from the execution phase.
 */
export interface RunnerExecutionResult {
  prd: PRD;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  allStoryMetrics: StoryMetrics[];
  completedEarly?: boolean;
  durationMs?: number;
}

/**
 * Execute the main execution phase (parallel and/or sequential paths).
 *
 * @param options - Execution options
 * @param prd - Product requirements document
 * @param pluginRegistry - Plugin registry
 * @returns Execution result
 */
export async function runExecutionPhase(
  options: RunnerExecutionOptions,
  prd: PRD,
  pluginRegistry: PluginRegistry,
): Promise<RunnerExecutionResult> {
  const logger = getSafeLogger();

  let iterations = 0;
  let storiesCompleted = 0;
  let totalCost = 0;
  const allStoryMetrics: StoryMetrics[] = [];

  // Output run header in headless mode
  if (options.headless && options.formatterMode !== "json") {
    const { outputRunHeader } = await import("./lifecycle/headless-formatter");
    await outputRunHeader({
      feature: options.feature,
      totalStories: prd.userStories.length,
      pendingStories: prd.userStories.filter((s) => s.status === "pending").length,
      workdir: options.workdir,
      formatterMode: options.formatterMode,
    });
  }

  // Status write point 1: run started
  options.statusWriter.setPrd(prd);
  options.statusWriter.setRunStatus("running");
  options.statusWriter.setCurrentStory(null);
  await options.statusWriter.update(totalCost, iterations);

  // Update reporters with correct totalStories count
  const reporters = pluginRegistry.getReporters();
  for (const reporter of reporters) {
    if (reporter.onRunStart) {
      try {
        await reporter.onRunStart({
          runId: options.runId,
          feature: options.feature,
          totalStories: prd.userStories.length,
          startTime: options.startedAt,
        });
      } catch (error) {
        logger?.warn("plugins", `Reporter '${reporter.name}' onRunStart failed`, { error });
      }
    }
  }

  logger?.info("execution", `Starting ${options.feature}`, {
    totalStories: prd.userStories.length,
    doneStories: prd.userStories.filter((s) => s.status === "passed").length,
    pendingStories: prd.userStories.filter((s) => s.status === "pending").length,
    batchingEnabled: options.useBatch,
  });

  // Clear LLM routing cache at start of new run
  clearLlmCache();

  // PERF-1: Precompute batch plan once from ready stories
  const readyStories = getAllReadyStories(prd);

  // BUG-068: debug log to diagnose unexpected storyCount in batch routing
  logger?.debug("routing", "Ready stories for batch routing", {
    readyCount: readyStories.length,
    readyIds: readyStories.map((s) => s.id),
    allStories: prd.userStories.map((s) => ({
      id: s.id,
      status: s.status,
      passes: s.passes,
      deps: s.dependencies,
    })),
  });

  const batchPlan = options.useBatch ? precomputeBatchPlan(readyStories, 4) : [];

  if (options.useBatch) {
    await tryLlmBatchRoute(options.config, readyStories, "routing");
  }

  // Parallel Execution Path (when --parallel is set)
  if (options.parallel !== undefined) {
    const runParallelExecution =
      options.runParallelExecution ?? (await import("./parallel-executor")).runParallelExecution;
    const parallelResult = await runParallelExecution(
      {
        prdPath: options.prdPath,
        workdir: options.workdir,
        config: options.config,
        hooks: options.hooks,
        feature: options.feature,
        featureDir: options.featureDir,
        parallelCount: options.parallel,
        eventEmitter: options.eventEmitter,
        statusWriter: options.statusWriter,
        runId: options.runId,
        startedAt: options.startedAt,
        startTime: options.startTime,
        totalCost,
        iterations,
        storiesCompleted,
        allStoryMetrics,
        pluginRegistry,
        formatterMode: options.formatterMode,
        headless: options.headless,
      },
      prd,
    );

    // biome-ignore lint/style/noParameterAssign: Update prd state through pipeline
    prd = parallelResult.prd;
    totalCost = parallelResult.totalCost;
    storiesCompleted = parallelResult.storiesCompleted;
    // BUG-066: merge parallel story metrics into the running accumulator
    allStoryMetrics.push(...parallelResult.storyMetrics);

    // If parallel execution completed everything, return early
    if (parallelResult.completed && parallelResult.durationMs !== undefined) {
      return {
        prd,
        iterations,
        storiesCompleted,
        totalCost,
        allStoryMetrics,
        completedEarly: true,
        durationMs: parallelResult.durationMs,
      };
    }
  }

  // Sequential Execution Path (default)
  const { executeSequential } = await import("./sequential-executor");
  const sequentialResult = await executeSequential(
    {
      prdPath: options.prdPath,
      workdir: options.workdir,
      config: options.config,
      hooks: options.hooks,
      feature: options.feature,
      featureDir: options.featureDir,
      dryRun: options.dryRun,
      useBatch: options.useBatch,
      pluginRegistry,
      eventEmitter: options.eventEmitter,
      statusWriter: options.statusWriter,
      logFilePath: options.logFilePath,
      runId: options.runId,
      startTime: options.startTime,
      batchPlan,
      agentGetFn: options.agentGetFn,
      pidRegistry: options.pidRegistry,
    },
    prd,
  );

  // biome-ignore lint/style/noParameterAssign: Update prd state through pipeline
  prd = sequentialResult.prd;
  iterations = sequentialResult.iterations;
  // BUG-064: accumulate (not overwrite) totalCost from sequential path
  totalCost += sequentialResult.totalCost;
  // BUG-065: accumulate (not overwrite) storiesCompleted from sequential path
  storiesCompleted += sequentialResult.storiesCompleted;
  allStoryMetrics.push(...sequentialResult.allStoryMetrics);

  return {
    prd,
    iterations,
    storiesCompleted,
    totalCost,
    allStoryMetrics,
  };
}
