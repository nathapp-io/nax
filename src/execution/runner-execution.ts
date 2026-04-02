/**
 * Runner Execution Phase
 *
 * Handles story execution via unified executor (parallel or sequential).
 * Extracted from runner.ts for better code organization.
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import type { InteractionChain } from "../interaction/chain";
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
  /** Protocol-aware agent resolver — created once in runner.ts from createAgentRegistry(config) */
  agentGetFn?: AgentGetFn;
  /** PID registry for crash recovery — passed to agent.run() to register child processes. */
  pidRegistry?: PidRegistry;
  /** Interaction chain for cost/pre-merge triggers during sequential execution. */
  interactionChain?: InteractionChain | null;
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
 * Execute the main execution phase via unified executor.
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

  const { executeUnified } = await import("./unified-executor");
  const unifiedResult = await executeUnified(
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
      parallelCount: options.parallel,
      agentGetFn: options.agentGetFn,
      pidRegistry: options.pidRegistry,
      interactionChain: options.interactionChain,
      batchPlan,
    },
    prd,
  );

  // biome-ignore lint/style/noParameterAssign: Update prd state through pipeline
  prd = unifiedResult.prd;
  iterations = unifiedResult.iterations;
  storiesCompleted = unifiedResult.storiesCompleted;
  totalCost = unifiedResult.totalCost;
  allStoryMetrics.push(...unifiedResult.allStoryMetrics);

  // Always let Phase 3 (runCompletionPhase) run to handle setRunStatus,
  // metrics, hooks, and cleanup — the unified executor does not perform these.
  logger?.debug("execution", "Execution phase complete — handing off to completion phase", {
    exitReason: unifiedResult.exitReason,
    iterations,
    storiesCompleted,
    totalCost,
  });
  return { prd, iterations, storiesCompleted, totalCost, allStoryMetrics };
}
