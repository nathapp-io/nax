/**
 * Parallel coordinator — Orchestrates parallel story execution
 */

import os from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { PipelineContext } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD, UserStory } from "../prd";
import { markStoryFailed, markStoryPassed, savePRD } from "../prd";
import { WorktreeManager } from "../worktree/manager";
import { MergeEngine, type StoryDependencies } from "../worktree/merge";
import { executeParallelBatch } from "./parallel-worker";

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
  mergeConflicts: Array<{ storyId: string; conflictFiles: string[]; originalCost: number }>;
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
  const allMergeConflicts: Array<{ storyId: string; conflictFiles: string[]; originalCost: number }> = [];

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

    // Create worktrees for all stories in batch
    const worktreePaths = new Map<string, string>();

    for (const story of batch) {
      const worktreePath = join(projectRoot, ".nax-wt", story.id);
      try {
        await worktreeManager.create(projectRoot, story.id);
        worktreePaths.set(story.id, worktreePath);

        logger?.info("parallel", "Created worktree for story", {
          storyId: story.id,
          worktreePath,
        });
      } catch (error) {
        markStoryFailed(currentPrd, story.id);
        logger?.error("parallel", "Failed to create worktree", {
          storyId: story.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Execute batch in parallel
    const batchResult = await executeParallelBatch(
      batch,
      projectRoot,
      config,
      baseContext,
      worktreePaths,
      maxConcurrency,
      eventEmitter,
    );

    totalCost += batchResult.totalCost;

    // Merge successful stories in topological order
    if (batchResult.pipelinePassed.length > 0) {
      const successfulIds = batchResult.pipelinePassed.map((s) => s.id);
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
          const mergedStory = batchResult.pipelinePassed.find((s) => s.id === mergeResult.storyId);
          if (mergedStory) batchResult.merged.push(mergedStory);

          logger?.info("parallel", "Story merged successfully", {
            storyId: mergeResult.storyId,
            retryCount: mergeResult.retryCount,
          });
        } else {
          // Merge conflict — mark story as failed
          markStoryFailed(currentPrd, mergeResult.storyId);
          batchResult.mergeConflicts.push({
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
    for (const { story, error } of batchResult.failed) {
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

    allMergeConflicts.push(...batchResult.mergeConflicts);

    logger?.info("parallel", `Batch ${batchIndex + 1} complete`, {
      pipelinePassed: batchResult.pipelinePassed.length,
      merged: batchResult.merged.length,
      failed: batchResult.failed.length,
      mergeConflicts: batchResult.mergeConflicts.length,
      batchCost: batchResult.totalCost,
    });
  }

  logger?.info("parallel", "Parallel execution complete", {
    storiesCompleted,
    totalCost,
  });

  return { storiesCompleted, totalCost, updatedPrd: currentPrd, mergeConflicts: allMergeConflicts };
}
