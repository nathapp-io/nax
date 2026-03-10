/**
 * Parallel Execution Wrapper
 *
 * Handles the full parallel execution flow:
 * - Status updates with parallel info
 * - Execute parallel stories
 * - Rectify merge conflicts (MFX-005): re-run conflicted stories sequentially
 *   on the updated base branch so each sees all previously merged stories
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
import { countStories, isComplete, markStoryPassed } from "../prd";
import { getAllReadyStories, hookCtx } from "./helpers";
import { executeParallel } from "./parallel";
import type { StatusWriter } from "./status-writer";

/** StoryMetrics extended with execution-path source */
export type ParallelStoryMetrics = StoryMetrics & {
  source: "parallel" | "sequential" | "rectification";
  rectifiedFromConflict?: boolean;
  originalCost?: number;
  rectificationCost?: number;
};

/** A story that conflicted during the initial parallel merge pass */
export interface ConflictedStoryInfo {
  storyId: string;
  conflictFiles: string[];
  originalCost: number;
}

/** Result from attempting to rectify a single conflicted story */
export type RectificationResult =
  | { success: true; storyId: string; cost: number }
  | {
      success: false;
      storyId: string;
      cost: number;
      finalConflict: boolean;
      pipelineFailure?: boolean;
      conflictFiles?: string[];
    };

/** Options passed to rectifyConflictedStory */
export interface RectifyConflictedStoryOptions extends ConflictedStoryInfo {
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  pluginRegistry: PluginRegistry;
  prd: PRD;
  eventEmitter?: PipelineEventEmitter;
}

/**
 * Actual implementation of rectifyConflictedStory.
 *
 * Steps:
 * 1. Remove the old worktree
 * 2. Create a fresh worktree from current HEAD (post-merge state)
 * 3. Re-run the full story pipeline
 * 4. Attempt merge on the updated base
 * 5. Return success/finalConflict
 */
async function rectifyConflictedStory(options: RectifyConflictedStoryOptions): Promise<RectificationResult> {
  const { storyId, workdir, config, hooks, pluginRegistry, prd, eventEmitter } = options;
  const logger = getSafeLogger();

  logger?.info("parallel", "Rectifying story on updated base", { storyId, attempt: "rectification" });

  try {
    const { WorktreeManager } = await import("../worktree/manager");
    const { MergeEngine } = await import("../worktree/merge");
    const { runPipeline } = await import("../pipeline/runner");
    const { defaultPipeline } = await import("../pipeline/stages");
    const { routeTask } = await import("../routing");

    const worktreeManager = new WorktreeManager();
    const mergeEngine = new MergeEngine(worktreeManager);

    // Step 1: Remove old worktree
    try {
      await worktreeManager.remove(workdir, storyId);
    } catch {
      // Ignore — worktree may have already been removed
    }

    // Step 2: Create fresh worktree from current HEAD
    await worktreeManager.create(workdir, storyId);
    const worktreePath = path.join(workdir, ".nax-wt", storyId);

    // Step 3: Re-run the story pipeline
    const story = prd.userStories.find((s) => s.id === storyId);
    if (!story) {
      return { success: false, storyId, cost: 0, finalConflict: false, pipelineFailure: true };
    }

    const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);

    const pipelineContext = {
      config,
      prd,
      story,
      stories: [story],
      workdir: worktreePath,
      featureDir: undefined,
      hooks,
      plugins: pluginRegistry,
      storyStartTime: new Date().toISOString(),
      routing: routing as import("../pipeline/types").RoutingResult,
    };

    const pipelineResult = await runPipeline(defaultPipeline, pipelineContext, eventEmitter);
    const cost = pipelineResult.context.agentResult?.estimatedCost ?? 0;

    if (!pipelineResult.success) {
      logger?.info("parallel", "Rectification failed - preserving worktree", { storyId });
      return { success: false, storyId, cost, finalConflict: false, pipelineFailure: true };
    }

    // Step 4: Attempt merge on updated base
    const mergeResults = await mergeEngine.mergeAll(workdir, [storyId], { [storyId]: [] });
    const mergeResult = mergeResults[0];

    if (!mergeResult || !mergeResult.success) {
      const conflictFiles = mergeResult?.conflictFiles ?? [];
      logger?.info("parallel", "Rectification failed - preserving worktree", { storyId });
      return { success: false, storyId, cost, finalConflict: true, conflictFiles };
    }

    logger?.info("parallel", "Rectification succeeded - story merged", {
      storyId,
      originalCost: options.originalCost,
      rectificationCost: cost,
    });
    return { success: true, storyId, cost };
  } catch (error) {
    logger?.error("parallel", "Rectification failed - preserving worktree", {
      storyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, storyId, cost: 0, finalConflict: false, pipelineFailure: true };
  }
}

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _parallelExecutorDeps = {
  fireHook,
  executeParallel,
  rectifyConflictedStory,
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

export interface RectificationStats {
  rectified: number;
  stillConflicting: number;
}

export interface ParallelExecutorResult {
  prd: PRD;
  totalCost: number;
  storiesCompleted: number;
  completed: boolean;
  durationMs?: number;
  /** Per-story metrics for stories completed via the parallel path */
  storyMetrics: ParallelStoryMetrics[];
  /** Stats from the merge-conflict rectification pass (MFX-005) */
  rectificationStats: RectificationStats;
}

/**
 * Run the rectification pass: sequentially re-run each conflicted story on
 * the updated base (which already includes all clean merges from the first pass).
 */
async function runRectificationPass(
  conflictedStories: ConflictedStoryInfo[],
  options: ParallelExecutorOptions,
  prd: PRD,
): Promise<{
  rectifiedCount: number;
  stillConflictingCount: number;
  additionalCost: number;
  updatedPrd: PRD;
  rectificationMetrics: ParallelStoryMetrics[];
}> {
  const logger = getSafeLogger();
  const { workdir, config, hooks, pluginRegistry, eventEmitter } = options;
  const rectificationMetrics: ParallelStoryMetrics[] = [];
  let rectifiedCount = 0;
  let stillConflictingCount = 0;
  let additionalCost = 0;

  logger?.info("parallel", "Starting merge conflict rectification", {
    stories: conflictedStories.map((s) => s.storyId),
    totalConflicts: conflictedStories.length,
  });

  // Sequential — each story sees all previously rectified stories in the base
  for (const conflictInfo of conflictedStories) {
    const result = await _parallelExecutorDeps.rectifyConflictedStory({
      ...conflictInfo,
      workdir,
      config,
      hooks,
      pluginRegistry,
      prd,
      eventEmitter,
    });

    additionalCost += result.cost;

    if (result.success) {
      markStoryPassed(prd, result.storyId);
      rectifiedCount++;

      rectificationMetrics.push({
        storyId: result.storyId,
        complexity: "unknown",
        modelTier: "parallel",
        modelUsed: "parallel",
        attempts: 1,
        finalTier: "parallel",
        success: true,
        cost: result.cost,
        durationMs: 0,
        firstPassSuccess: false,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        source: "rectification" as const,
        rectifiedFromConflict: true,
        originalCost: conflictInfo.originalCost,
        rectificationCost: result.cost,
      });
    } else {
      const isFinalConflict = result.finalConflict === true;
      if (isFinalConflict) {
        stillConflictingCount++;
      }
      // pipelineFailure — not counted as structural conflict, story remains failed
    }
  }

  logger?.info("parallel", "Rectification complete", {
    rectified: rectifiedCount,
    stillConflicting: stillConflictingCount,
  });

  return { rectifiedCount, stillConflictingCount, additionalCost, updatedPrd: prd, rectificationMetrics };
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
    return {
      prd,
      totalCost,
      storiesCompleted,
      completed: false,
      storyMetrics: [],
      rectificationStats: { rectified: 0, stillConflicting: 0 },
    };
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

  // Track which stories were already passed before this batch
  const initialPassedIds = new Set(initialPrd.userStories.filter((s) => s.status === "passed").map((s) => s.id));
  const batchStartedAt = new Date().toISOString();
  const batchStartMs = Date.now();
  const batchStoryMetrics: ParallelStoryMetrics[] = [];

  let conflictedStories: ConflictedStoryInfo[] = [];

  try {
    const parallelResult = await _parallelExecutorDeps.executeParallel(
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

    const batchDurationMs = Date.now() - batchStartMs;
    const batchCompletedAt = new Date().toISOString();

    prd = parallelResult.updatedPrd;
    storiesCompleted += parallelResult.storiesCompleted;
    totalCost += parallelResult.totalCost;
    conflictedStories = parallelResult.mergeConflicts ?? [];

    // BUG-066: Build per-story metrics for stories newly completed by this parallel batch
    const newlyPassedStories = prd.userStories.filter((s) => s.status === "passed" && !initialPassedIds.has(s.id));
    const costPerStory = newlyPassedStories.length > 0 ? parallelResult.totalCost / newlyPassedStories.length : 0;
    for (const story of newlyPassedStories) {
      batchStoryMetrics.push({
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
      });
    }

    allStoryMetrics.push(...batchStoryMetrics);

    // Log each conflict before scheduling rectification
    for (const conflict of conflictedStories) {
      logger?.info("parallel", "Merge conflict detected - scheduling for rectification", {
        storyId: conflict.storyId,
        conflictFiles: conflict.conflictFiles,
      });
    }

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

  // ── MFX-005: Rectification pass ────────────────────────────────────────────
  let rectificationStats: RectificationStats = { rectified: 0, stillConflicting: 0 };

  if (conflictedStories.length > 0) {
    const rectResult = await runRectificationPass(conflictedStories, options, prd);
    prd = rectResult.updatedPrd;
    storiesCompleted += rectResult.rectifiedCount;
    totalCost += rectResult.additionalCost;
    rectificationStats = {
      rectified: rectResult.rectifiedCount,
      stillConflicting: rectResult.stillConflictingCount,
    };
    batchStoryMetrics.push(...rectResult.rectificationMetrics);
    allStoryMetrics.push(...rectResult.rectificationMetrics);
  }

  // Check if all stories are complete after parallel execution + rectification
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
      storyMetrics: batchStoryMetrics,
      rectificationStats,
    };
  }

  return { prd, totalCost, storiesCompleted, completed: false, storyMetrics: batchStoryMetrics, rectificationStats };
}
