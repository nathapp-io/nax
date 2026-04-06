/**
 * Parallel worker — Story execution in worktrees
 */

import { join } from "node:path";
import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import type { PipelineRunResult } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext, RoutingResult } from "../pipeline/types";
import type { UserStory } from "../prd";
import { routeTask } from "../routing";
import { errorMessage } from "../utils/errors";
import { captureGitRef, isGitRefValid } from "../utils/git";

/**
 * Execute a single story in its worktree
 */
export async function executeStoryInWorktree(
  story: UserStory,
  worktreePath: string,
  context: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">,
  routing: RoutingResult,
  eventEmitter?: PipelineEventEmitter,
): Promise<{ success: boolean; cost: number; error?: string; pipelineResult?: PipelineRunResult }> {
  const logger = getSafeLogger();

  try {
    // Capture storyGitRef from the worktree before execution (mirrors iteration-runner.ts BUG-114).
    // In parallel mode, each story runs directly via runPipeline (bypassing iteration-runner),
    // so we must capture the ref here to ensure review/verify stages can diff against the
    // pre-execution HEAD.
    let storyGitRef: string | undefined;
    if (story.storyGitRef && (await isGitRefValid(worktreePath, story.storyGitRef))) {
      storyGitRef = story.storyGitRef;
    } else {
      storyGitRef = await captureGitRef(worktreePath);
      if (storyGitRef) {
        story.storyGitRef = storyGitRef;
      }
    }

    const pipelineContext: PipelineContext = {
      ...context,
      effectiveConfig: context.effectiveConfig ?? context.config,
      story,
      stories: [story],
      workdir: worktreePath,
      routing,
      storyGitRef: storyGitRef ?? undefined,
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
      pipelineResult: result,
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
  failed: Array<{ story: UserStory; error: string; pipelineResult?: PipelineRunResult }>;
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
  // #93: Per-story effective configs (PKG-003) — if absent falls back to context.effectiveConfig
  storyEffectiveConfigs?: Map<string, NaxConfig>,
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

    // #93: Override effectiveConfig with per-story resolved config (PKG-003) if available
    const storyConfig = storyEffectiveConfigs?.get(story.id);
    const storyContext = storyConfig ? { ...context, effectiveConfig: storyConfig } : context;

    const executePromise = executeStoryInWorktree(
      story,
      worktreePath,
      storyContext,
      routing as RoutingResult,
      eventEmitter,
    )
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
          results.failed.push({ story, error: result.error || "Unknown error", pipelineResult: result.pipelineResult });
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

    // Drain until we are below the concurrency limit. Using `while` (not `if`) handles
    // the case where multiple promises resolve between two awaits: each iteration of
    // Promise.race flushes one completion, and the .finally() cleanup runs as a microtask
    // before the next loop evaluation, so the Set size converges correctly.
    while (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining executions
  await Promise.all(executing);

  return results;
}
