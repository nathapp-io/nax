/**
 * Unified Executor
 *
 * Single dispatch point for story execution.
 * Handles both parallel (when parallelCount is set) and sequential execution.
 */

import * as os from "node:os";
import path from "node:path";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { fireHook } from "../hooks";
import type { InteractionChain } from "../interaction/chain";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { saveRunMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { AgentGetFn } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD } from "../prd";
import { countStories, isComplete } from "../prd";
import { errorMessage } from "../utils/errors";
import type { StoryBatch } from "./batching";
import { getAllReadyStories, hookCtx } from "./helpers";
import {
  type RectificationResult,
  type RectifyConflictedStoryOptions,
  rectifyConflictedStory,
} from "./merge-conflict-rectify";
import { executeParallel } from "./parallel-coordinator";
import type { PidRegistry } from "./pid-registry";
import type { StatusWriter } from "./status-writer";

export interface UnifiedExecutorOptions {
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
  parallelCount?: number;
  agentGetFn?: AgentGetFn;
  pidRegistry?: PidRegistry;
  interactionChain?: InteractionChain | null;
  pluginRegistry: PluginRegistry;
  batchPlan: StoryBatch[];
  totalCost: number;
  iterations: number;
  storiesCompleted: number;
  allStoryMetrics: StoryMetrics[];
}

export interface UnifiedExecutorResult {
  prd: PRD;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  allStoryMetrics: StoryMetrics[];
  completedEarly?: boolean;
  durationMs?: number;
}

/**
 * Execute stories using the appropriate strategy.
 * Uses parallel execution when parallelCount is set, otherwise sequential.
 */
export async function executeUnified(options: UnifiedExecutorOptions, prd: PRD): Promise<UnifiedExecutorResult> {
  const { parallelCount } = options;

  if (parallelCount !== undefined) {
    return executeUnifiedParallel(options, prd);
  }

  return executeUnifiedSequential(options, prd);
}

async function executeUnifiedSequential(options: UnifiedExecutorOptions, prd: PRD): Promise<UnifiedExecutorResult> {
  const { executeSequential } = await import("./sequential-executor");
  const result = await executeSequential(
    {
      prdPath: options.prdPath,
      workdir: options.workdir,
      config: options.config,
      hooks: options.hooks,
      feature: options.feature,
      featureDir: options.featureDir,
      dryRun: options.dryRun,
      useBatch: options.useBatch,
      pluginRegistry: options.pluginRegistry,
      eventEmitter: options.eventEmitter,
      statusWriter: options.statusWriter,
      logFilePath: options.logFilePath,
      runId: options.runId,
      startTime: options.startTime,
      batchPlan: options.batchPlan,
      agentGetFn: options.agentGetFn,
      pidRegistry: options.pidRegistry,
      interactionChain: options.interactionChain,
    },
    prd,
  );

  return {
    prd: result.prd,
    iterations: result.iterations,
    storiesCompleted: options.storiesCompleted + result.storiesCompleted,
    totalCost: options.totalCost + result.totalCost,
    allStoryMetrics: [...options.allStoryMetrics, ...result.allStoryMetrics],
  };
}

async function executeUnifiedParallel(
  options: UnifiedExecutorOptions,
  initialPrd: PRD,
): Promise<UnifiedExecutorResult> {
  const logger = getSafeLogger();
  const {
    workdir,
    config,
    hooks,
    feature,
    featureDir,
    prdPath,
    runId,
    startedAt,
    startTime,
    pluginRegistry,
    formatterMode,
    headless,
    eventEmitter,
    agentGetFn,
    pidRegistry,
    interactionChain,
  } = options;

  let { totalCost, storiesCompleted, allStoryMetrics } = options;
  const { iterations } = options;
  let prd = initialPrd;

  const parallelCount = options.parallelCount as number;
  const readyStories = getAllReadyStories(prd);
  if (readyStories.length === 0) {
    return { prd, iterations, storiesCompleted, totalCost, allStoryMetrics };
  }

  const maxConcurrency = parallelCount === 0 ? os.cpus().length : Math.max(1, parallelCount);
  const initialPassedIds = new Set(initialPrd.userStories.filter((s) => s.status === "passed").map((s) => s.id));
  const batchStartedAt = new Date().toISOString();
  const batchStartMs = Date.now();

  options.statusWriter.setPrd(prd);
  await options.statusWriter.update(totalCost, iterations, {
    parallel: {
      enabled: true,
      maxConcurrency,
      activeStories: readyStories.map((s) => ({
        storyId: s.id,
        worktreePath: path.join(workdir, ".nax-wt", s.id),
      })),
    },
  });

  let conflictedStories: Array<{ storyId: string; conflictFiles: string[]; originalCost: number }> = [];

  try {
    const parallelResult = await executeParallel(
      readyStories,
      prdPath,
      workdir,
      config,
      hooks,
      pluginRegistry,
      prd,
      featureDir,
      parallelCount,
      eventEmitter,
      agentGetFn,
      pidRegistry,
      interactionChain,
    );

    const batchDurationMs = Date.now() - batchStartMs;
    const batchCompletedAt = new Date().toISOString();
    prd = parallelResult.updatedPrd;
    storiesCompleted += parallelResult.storiesCompleted;
    totalCost += parallelResult.totalCost;
    conflictedStories = parallelResult.mergeConflicts ?? [];

    const newlyPassed = prd.userStories.filter((s) => s.status === "passed" && !initialPassedIds.has(s.id));
    const costPerStory = newlyPassed.length > 0 ? parallelResult.totalCost / newlyPassed.length : 0;
    const batchMetrics: StoryMetrics[] = newlyPassed.map((story) => ({
      storyId: story.id,
      complexity: "unknown",
      modelTier: "parallel",
      modelUsed: "parallel",
      attempts: 1,
      finalTier: "parallel",
      success: true,
      cost: costPerStory,
      durationMs: batchDurationMs,
      firstPassSuccess: true,
      startedAt: batchStartedAt,
      completedAt: batchCompletedAt,
      source: "parallel" as const,
    }));
    allStoryMetrics = [...allStoryMetrics, ...batchMetrics];

    options.statusWriter.setPrd(prd);
    await options.statusWriter.update(totalCost, iterations, {
      parallel: { enabled: true, maxConcurrency, activeStories: [] },
    });
  } catch (error) {
    logger?.error("parallel", "Parallel execution failed", { error: errorMessage(error) });
    await options.statusWriter.update(totalCost, iterations, { parallel: undefined });
    throw error;
  }

  // Rectification pass for merge conflicts
  for (const conflictInfo of conflictedStories) {
    try {
      const result: RectificationResult = await rectifyConflictedStory({
        ...conflictInfo,
        workdir,
        config,
        hooks,
        pluginRegistry,
        prd: initialPrd,
        eventEmitter,
        agentGetFn,
      } as RectifyConflictedStoryOptions);
      if (result.success) {
        storiesCompleted++;
        totalCost += result.cost;
      }
    } catch (err) {
      logger?.warn("parallel", "Rectification failed", {
        storyId: conflictInfo.storyId,
        error: errorMessage(err),
      });
    }
  }

  if (isComplete(prd)) {
    await fireHook(hooks, "on-all-stories-complete", hookCtx(feature, { status: "passed", cost: totalCost }), workdir);
    await fireHook(hooks, "on-complete", hookCtx(feature, { status: "complete", cost: totalCost }), workdir);

    const durationMs = Date.now() - startTime;
    const runCompletedAt = new Date().toISOString();

    const finalCounts = countStories(prd);
    await saveRunMetrics(workdir, {
      runId,
      feature,
      startedAt,
      completedAt: runCompletedAt,
      totalCost,
      totalStories: allStoryMetrics.length,
      storiesCompleted,
      storiesFailed: finalCounts.failed,
      totalDurationMs: durationMs,
      stories: allStoryMetrics,
    });

    const reporters = pluginRegistry.getReporters();
    for (const reporter of reporters) {
      if (reporter.onRunEnd) {
        try {
          await reporter.onRunEnd({
            runId,
            totalDurationMs: durationMs,
            totalCost,
            storySummary: {
              completed: storiesCompleted,
              failed: finalCounts.failed,
              skipped: finalCounts.skipped,
              paused: finalCounts.paused,
            },
          });
        } catch (e) {
          logger?.warn("plugins", "Reporter onRunEnd failed", { error: errorMessage(e) });
        }
      }
    }

    options.statusWriter.setPrd(prd);
    options.statusWriter.setCurrentStory(null);
    options.statusWriter.setRunStatus("completed");
    await options.statusWriter.update(totalCost, iterations);

    if (headless && formatterMode !== "json") {
      const { outputRunFooter } = await import("./lifecycle/headless-formatter");
      outputRunFooter({
        finalCounts: {
          total: finalCounts.total,
          passed: finalCounts.passed,
          failed: finalCounts.failed,
          skipped: finalCounts.skipped,
        },
        durationMs,
        totalCost,
        startedAt,
        completedAt: runCompletedAt,
        formatterMode,
      });
    }

    return {
      prd,
      iterations,
      storiesCompleted,
      totalCost,
      allStoryMetrics,
      completedEarly: true,
      durationMs,
    };
  }

  return { prd, iterations, storiesCompleted, totalCost, allStoryMetrics };
}
