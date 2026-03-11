/**
 * Parallel worker — Story execution in worktrees
 */

import { join } from "node:path";
import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext, RoutingResult } from "../pipeline/types";
import type { UserStory } from "../prd";
import { routeTask } from "../routing";
import { errorMessage } from "../utils/errors";

/**
 * Execute a single story in its worktree
 */
export async function executeStoryInWorktree(
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
      error: errorMessage(error),
    };
  }
}

/**
 * Batch execution result
 */
export interface ParallelBatchResult {
  /** Stories that passed the TDD pipeline (pre-merge) */
  pipelinePassed: UserStory[];
  /** Stories that were actually merged to the base branch */
  merged: UserStory[];
  /** Stories that failed the pipeline */
  failed: Array<{ story: UserStory; error: string }>;
  /** Total cost accumulated */
  totalCost: number;
  /** Stories with merge conflicts (includes per-story original cost for rectification) */
  mergeConflicts: Array<{ storyId: string; conflictFiles: string[]; originalCost: number }>;
  /** Per-story execution costs for successful stories */
  storyCosts: Map<string, number>;
}

/**
 * Execute a batch of independent stories in parallel (worktree setup must be done separately)
 */
export async function executeParallelBatch(
  stories: UserStory[],
  projectRoot: string,
  config: NaxConfig,
  context: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">,
  worktreePaths: Map<string, string>,
  maxConcurrency: number,
  eventEmitter?: PipelineEventEmitter,
): Promise<ParallelBatchResult> {
  const logger = getSafeLogger();
  const results: ParallelBatchResult = {
    pipelinePassed: [],
    merged: [],
    failed: [],
    totalCost: 0,
    mergeConflicts: [],
    storyCosts: new Map(),
  };

  // Execute stories in parallel with concurrency limit
  const executing = new Set<Promise<void>>();

  for (const story of stories) {
    const worktreePath = worktreePaths.get(story.id);
    if (!worktreePath) {
      results.failed.push({
        story,
        error: "Worktree not created",
      });
      continue;
    }

    const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);

    const executePromise = executeStoryInWorktree(story, worktreePath, context, routing as RoutingResult, eventEmitter)
      .then((result) => {
        results.totalCost += result.cost;
        results.storyCosts.set(story.id, result.cost);

        if (result.success) {
          results.pipelinePassed.push(story);
          logger?.info("parallel", "Story execution succeeded", {
            storyId: story.id,
            cost: result.cost,
          });
        } else {
          results.failed.push({ story, error: result.error || "Unknown error" });
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
