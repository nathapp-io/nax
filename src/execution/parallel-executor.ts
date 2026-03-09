/**
 * Parallel Execution Wrapper
 *
 * Handles the full parallel execution flow:
 * - Status updates with parallel info
 * - Execute parallel stories
 * - Handle completion or continue to sequential
 */

import * as os from "node:os";
import path from "node:path";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD } from "../prd";
import { countStories, isComplete } from "../prd";
import { getAllReadyStories, hookCtx } from "./helpers";
import { executeParallel } from "./parallel";
import type { StatusWriter } from "./status-writer";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _parallelExecutorDeps = {
  fireHook,
};

export interface ParallelExecutorOptions {
  prdPath: string;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  featureDir?: string;
  parallelCount: number;
  eventEmitter?: PipelineEventEmitter;
  statusWriter: StatusWriter;
  runId: string;
  startedAt: string;
  startTime: number;
  totalCost: number;
  iterations: number;
  storiesCompleted: number;
  allStoryMetrics: StoryMetrics[];
  pluginRegistry: PluginRegistry;
  formatterMode: "quiet" | "normal" | "verbose" | "json";
  headless: boolean;
}

export interface ParallelExecutorResult {
  prd: PRD;
  totalCost: number;
  storiesCompleted: number;
  completed: boolean;
  durationMs?: number;
}

/**
 * Execute parallel stories if --parallel is set
 */
export async function runParallelExecution(
  options: ParallelExecutorOptions,
  initialPrd: PRD,
): Promise<ParallelExecutorResult> {
  const logger = getSafeLogger();
  const {
    prdPath,
    workdir,
    config,
    hooks,
    feature,
    featureDir,
    parallelCount,
    eventEmitter,
    statusWriter,
    runId,
    startedAt,
    startTime,
    pluginRegistry,
    formatterMode,
    headless,
  } = options;

  let { totalCost, iterations, storiesCompleted, allStoryMetrics } = options;
  let prd = initialPrd;

  const readyStories = getAllReadyStories(prd);
  if (readyStories.length === 0) {
    logger?.info("parallel", "No stories ready for parallel execution");
    return { prd, totalCost, storiesCompleted, completed: false };
  }

  const maxConcurrency = parallelCount === 0 ? os.cpus().length : Math.max(1, parallelCount);

  logger?.info("parallel", "Starting parallel execution mode", {
    totalStories: readyStories.length,
    maxConcurrency,
  });

  // Update status with parallel info
  statusWriter.setPrd(prd);
  await statusWriter.update(totalCost, iterations, {
    parallel: {
      enabled: true,
      maxConcurrency,
      activeStories: readyStories.map((s) => ({
        storyId: s.id,
        worktreePath: path.join(workdir, ".nax-wt", s.id),
      })),
    },
  });

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
    );

    prd = parallelResult.updatedPrd;
    storiesCompleted += parallelResult.storiesCompleted;
    totalCost += parallelResult.totalCost;

    logger?.info("parallel", "Parallel execution complete", {
      storiesCompleted: parallelResult.storiesCompleted,
      totalCost: parallelResult.totalCost,
    });

    // Clear parallel status
    statusWriter.setPrd(prd);
    await statusWriter.update(totalCost, iterations, {
      parallel: {
        enabled: true,
        maxConcurrency,
        activeStories: [],
      },
    });
  } catch (error) {
    logger?.error("parallel", "Parallel execution failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Clear parallel status on error
    await statusWriter.update(totalCost, iterations, {
      parallel: undefined,
    });

    throw error;
  }

  // Check if all stories are complete after parallel execution
  if (isComplete(prd)) {
    logger?.info("execution", "All stories complete!", {
      feature,
      totalCost,
    });
    await _parallelExecutorDeps.fireHook(
      hooks,
      "on-all-stories-complete",
      hookCtx(feature, { status: "passed", cost: totalCost }),
      workdir,
    );
    await _parallelExecutorDeps.fireHook(
      hooks,
      "on-complete",
      hookCtx(feature, { status: "complete", cost: totalCost }),
      workdir,
    );

    // Skip to metrics and cleanup
    const durationMs = Date.now() - startTime;
    const runCompletedAt = new Date().toISOString();

    const { handleParallelCompletion } = await import("./lifecycle/parallel-lifecycle");
    await handleParallelCompletion({
      runId,
      feature,
      startedAt,
      completedAt: runCompletedAt,
      prd,
      allStoryMetrics,
      totalCost,
      storiesCompleted,
      durationMs,
      workdir,
      pluginRegistry,
    });

    const finalCounts = countStories(prd);
    statusWriter.setPrd(prd);
    statusWriter.setCurrentStory(null);
    statusWriter.setRunStatus("completed");
    await statusWriter.update(totalCost, iterations);

    // ── Output run footer in headless mode (parallel path) ──────────────
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
      totalCost,
      storiesCompleted,
      completed: true,
      durationMs,
    };
  }

  return { prd, totalCost, storiesCompleted, completed: false };
}
