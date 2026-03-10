/**
 * Parallel Execution — Worktree-based concurrent story execution
 *
 * Orchestrates parallel story execution using git worktrees: groups stories
 * by dependencies, creates worktrees, dispatches concurrent pipelines,
 * merges in dependency order, and cleans up worktrees.
 */

import os from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext, RoutingResult } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD, UserStory } from "../prd";
import { markStoryFailed, markStoryPassed, savePRD } from "../prd";
import { routeTask, tryLlmBatchRoute } from "../routing";
import { WorktreeManager } from "../worktree/manager";
import { MergeEngine, type StoryDependencies } from "../worktree/merge";

/**
 * Result from parallel execution of a batch of stories
 */
export interface ParallelBatchResult {
  /** Stories that completed successfully */
  successfulStories: UserStory[];
  /** Stories that failed */
  failedStories: Array<{ story: UserStory; error: string }>;
  /** Total cost accumulated */
  totalCost: number;
  /** Stories with merge conflicts (includes per-story original cost for rectification) */
  conflictedStories: Array<{ storyId: string; conflictFiles: string[]; originalCost: number }>;
  /** Per-story execution costs for successful stories */
  storyCosts: Map<string, number>;
}

/**
 * Group stories into dependency batches; stories in each batch can run in parallel.
 */
function groupStoriesByDependencies(stories: UserStory[]): UserStory[][] {
  const batches: UserStory[][] = [];
  const processed = new Set<string>();
  const storyMap = new Map(stories.map((s) => [s.id, s]));

  // Keep processing until all stories are batched
  while (processed.size < stories.length) {
    const batch: UserStory[] = [];

    for (const story of stories) {
      if (processed.has(story.id)) continue;

      // Check if all dependencies are satisfied
      const depsCompleted = story.dependencies.every((dep) => processed.has(dep) || !storyMap.has(dep));

      if (depsCompleted) {
        batch.push(story);
      }
    }

    if (batch.length === 0) {
      // No stories ready — circular dependency or missing dep
      const remaining = stories.filter((s) => !processed.has(s.id));
      const logger = getSafeLogger();
      logger?.error("parallel", "Cannot resolve story dependencies", {
        remainingStories: remaining.map((s) => s.id),
      });
      throw new Error("Circular dependency or missing dependency detected");
    }

    // Mark batch stories as processed
    for (const story of batch) {
      processed.add(story.id);
    }

    batches.push(batch);
  }

  return batches;
}

/**
 * Build dependency map for merge engine
 */
function buildDependencyMap(stories: UserStory[]): StoryDependencies {
  const deps: StoryDependencies = {};
  for (const story of stories) {
    deps[story.id] = story.dependencies;
  }
  return deps;
}

/**
 * Execute a single story in its worktree
 */
async function executeStoryInWorktree(
  story: UserStory,
  worktreePath: string,
  context: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">,
  routing: RoutingResult,
  eventEmitter?: PipelineEventEmitter,
): Promise<{ success: boolean; cost: number; error?: string }> {
  const logger = getSafeLogger();

  try {
    const pipelineContext: PipelineContext = {
      ...context,
      story,
      stories: [story],
      workdir: worktreePath,
      routing,
    };

    logger?.debug("parallel", "Executing story in worktree", {
      storyId: story.id,
      worktreePath,
    });

    const result = await runPipeline(defaultPipeline, pipelineContext, eventEmitter);

    return {
      success: result.success,
      cost: result.context.agentResult?.estimatedCost || 0,
      error: result.success ? undefined : result.reason,
    };
  } catch (error) {
    return {
      success: false,
      cost: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute a batch of independent stories in parallel
 */
async function executeParallelBatch(
  stories: UserStory[],
  projectRoot: string,
  config: NaxConfig,
  prd: PRD,
  context: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">,
  maxConcurrency: number,
  eventEmitter?: PipelineEventEmitter,
): Promise<ParallelBatchResult> {
  const logger = getSafeLogger();
  const worktreeManager = new WorktreeManager();
  const results: ParallelBatchResult = {
    successfulStories: [],
    failedStories: [],
    totalCost: 0,
    conflictedStories: [],
    storyCosts: new Map(),
  };

  // Create worktrees for all stories in batch
  const worktreeSetup: Array<{ story: UserStory; worktreePath: string }> = [];

  for (const story of stories) {
    const worktreePath = join(projectRoot, ".nax-wt", story.id);
    try {
      await worktreeManager.create(projectRoot, story.id);
      worktreeSetup.push({ story, worktreePath });

      logger?.info("parallel", "Created worktree for story", {
        storyId: story.id,
        worktreePath,
      });
    } catch (error) {
      results.failedStories.push({
        story,
        error: `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
      });
      logger?.error("parallel", "Failed to create worktree", {
        storyId: story.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Execute stories in parallel with concurrency limit
  const executing = new Set<Promise<void>>();

  for (const { story, worktreePath } of worktreeSetup) {
    const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);

    const executePromise = executeStoryInWorktree(story, worktreePath, context, routing as RoutingResult, eventEmitter)
      .then((result) => {
        results.totalCost += result.cost;
        results.storyCosts.set(story.id, result.cost);

        if (result.success) {
          results.successfulStories.push(story);
          logger?.info("parallel", "Story execution succeeded", {
            storyId: story.id,
            cost: result.cost,
          });
        } else {
          results.failedStories.push({ story, error: result.error || "Unknown error" });
          logger?.error("parallel", "Story execution failed", {
            storyId: story.id,
            error: result.error,
          });
        }
      })
      .finally(() => {
        executing.delete(executePromise);
      });

    executing.add(executePromise);

    // Wait if we've hit the concurrency limit
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining executions
  await Promise.all(executing);

  return results;
}

/**
 * Determine max concurrency from parallel option
 * - undefined: sequential mode (should not call this function)
 * - 0: auto-detect (use CPU count)
 * - N > 0: use N
 */
function resolveMaxConcurrency(parallel: number): number {
  if (parallel === 0) {
    return os.cpus().length;
  }
  return Math.max(1, parallel);
}

/**
 * Execute stories in parallel using worktree pipeline
 *
 * High-level flow:
 * 1. Group stories by dependencies into batches
 * 2. For each batch:
 *    a. Create worktrees for all stories
 *    b. Execute pipeline in parallel (respecting maxConcurrency)
 *    c. Merge successful branches in topological order
 *    d. Clean up worktrees on success, preserve on failure
 * 3. Update PRD with results
 */
export async function executeParallel(
  stories: UserStory[],
  prdPath: string,
  projectRoot: string,
  config: NaxConfig,
  hooks: LoadedHooksConfig,
  plugins: PluginRegistry,
  prd: PRD,
  featureDir: string | undefined,
  parallel: number,
  eventEmitter?: PipelineEventEmitter,
): Promise<{
  storiesCompleted: number;
  totalCost: number;
  updatedPrd: PRD;
  conflictedStories: Array<{ storyId: string; conflictFiles: string[]; originalCost: number }>;
}> {
  const logger = getSafeLogger();
  const maxConcurrency = resolveMaxConcurrency(parallel);
  const worktreeManager = new WorktreeManager();
  const mergeEngine = new MergeEngine(worktreeManager);

  logger?.info("parallel", "Starting parallel execution", {
    totalStories: stories.length,
    maxConcurrency,
  });

  // Group stories by dependencies
  const batches = groupStoriesByDependencies(stories);
  logger?.info("parallel", "Grouped stories into batches", {
    batchCount: batches.length,
    batches: batches.map((b, i) => ({ index: i, storyCount: b.length, storyIds: b.map((s) => s.id) })),
  });

  let storiesCompleted = 0;
  let totalCost = 0;
  const currentPrd = prd;
  const allConflictedStories: Array<{ storyId: string; conflictFiles: string[]; originalCost: number }> = [];

  // Execute each batch sequentially (stories within each batch run in parallel)
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    logger?.info("parallel", `Executing batch ${batchIndex + 1}/${batches.length}`, {
      storyCount: batch.length,
      storyIds: batch.map((s) => s.id),
    });

    // Build context for this batch (shared across all stories in batch)
    const baseContext = {
      config,
      prd: currentPrd,
      featureDir,
      hooks,
      plugins,
      storyStartTime: new Date().toISOString(),
    };

    // Execute batch in parallel
    const batchResult = await executeParallelBatch(
      batch,
      projectRoot,
      config,
      currentPrd,
      baseContext,
      maxConcurrency,
      eventEmitter,
    );

    totalCost += batchResult.totalCost;

    // Merge successful stories in topological order
    if (batchResult.successfulStories.length > 0) {
      const successfulIds = batchResult.successfulStories.map((s) => s.id);
      const deps = buildDependencyMap(batch);

      logger?.info("parallel", "Merging successful stories", {
        storyIds: successfulIds,
      });

      const mergeResults = await mergeEngine.mergeAll(projectRoot, successfulIds, deps);

      // Process merge results
      for (const mergeResult of mergeResults) {
        if (mergeResult.success) {
          // Update PRD: mark story as passed
          markStoryPassed(currentPrd, mergeResult.storyId);
          storiesCompleted++;

          logger?.info("parallel", "Story merged successfully", {
            storyId: mergeResult.storyId,
            retryCount: mergeResult.retryCount,
          });
        } else {
          // Merge conflict — mark story as failed
          markStoryFailed(currentPrd, mergeResult.storyId);
          batchResult.conflictedStories.push({
            storyId: mergeResult.storyId,
            conflictFiles: mergeResult.conflictFiles || [],
            originalCost: batchResult.storyCosts.get(mergeResult.storyId) ?? 0,
          });

          logger?.error("parallel", "Merge conflict", {
            storyId: mergeResult.storyId,
            conflictFiles: mergeResult.conflictFiles,
          });

          // Keep worktree for manual resolution
          logger?.warn("parallel", "Worktree preserved for manual conflict resolution", {
            storyId: mergeResult.storyId,
            worktreePath: join(projectRoot, ".nax-wt", mergeResult.storyId),
          });
        }
      }
    }

    // Mark failed stories in PRD and clean up their worktrees
    for (const { story, error } of batchResult.failedStories) {
      markStoryFailed(currentPrd, story.id);

      logger?.error("parallel", "Cleaning up failed story worktree", {
        storyId: story.id,
        error,
      });

      try {
        await worktreeManager.remove(projectRoot, story.id);
      } catch (cleanupError) {
        logger?.warn("parallel", "Failed to clean up worktree", {
          storyId: story.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }

    // Save PRD after each batch
    await savePRD(currentPrd, prdPath);

    allConflictedStories.push(...batchResult.conflictedStories);

    logger?.info("parallel", `Batch ${batchIndex + 1} complete`, {
      successful: batchResult.successfulStories.length,
      failed: batchResult.failedStories.length,
      conflicts: batchResult.conflictedStories.length,
      batchCost: batchResult.totalCost,
    });
  }

  logger?.info("parallel", "Parallel execution complete", {
    storiesCompleted,
    totalCost,
  });

  return { storiesCompleted, totalCost, updatedPrd: currentPrd, conflictedStories: allConflictedStories };
}
