/**
 * Parallel Batch Orchestration
 *
 * Extracts batch orchestration logic:
 * - Creates worktrees
 * - Runs executeParallelBatch (from parallel-worker.ts)
 * - Merges results via MergeEngine
 * - Runs a rectification pass for conflicts
 * - Returns RunParallelBatchResult with per-story costs from storyCosts Map
 *
 */

import path from "node:path";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { PipelineRunResult } from "../pipeline/runner";
import type { AgentGetFn, PipelineContext } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD, UserStory } from "../prd/types";
import type { ConflictedStoryInfo } from "./merge-conflict-rectify";

/**
 * Result returned by runParallelBatch.
 * Per-story costs come from executeParallelBatch's storyCosts Map — not an even-split.
 */
export interface RunParallelBatchResult {
  /** Stories whose pipeline passed and were merged to the base branch */
  completed: UserStory[];
  /** Stories whose pipeline did not pass */
  failed: Array<{ story: UserStory; pipelineResult: PipelineRunResult }>;
  /** Stories that had a merge conflict, with rectification outcome */
  mergeConflicts: Array<{ story: UserStory; rectified: boolean; cost: number }>;
  /** Per-story execution costs (direct from executeParallelBatch, not averaged) */
  storyCosts: Map<string, number>;
  /** Per-story elapsed times in milliseconds (worktree creation to merge completion) */
  storyDurations?: Map<string, number>;
  /** Sum of all per-story costs in the batch */
  totalCost: number;
}

/**
 * Context required for a parallel batch run.
 */
export interface ParallelBatchCtx {
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  pluginRegistry: PluginRegistry;
  maxConcurrency: number;
  pipelineContext: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">;
  eventEmitter?: PipelineEventEmitter;
  agentGetFn?: AgentGetFn;
}

/**
 * Options for runParallelBatch.
 */
export interface RunParallelBatchOptions {
  stories: UserStory[];
  ctx: ParallelBatchCtx;
  prd: PRD;
}

/**
 * Injectable dependencies for testing.
 * @internal — test use only.
 */
export const _parallelBatchDeps = {
  executeParallelBatch: async (
    _stories: UserStory[],
    _projectRoot: string,
    _config: NaxConfig,
    _context: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">,
    _worktreePaths: Map<string, string>,
    _maxConcurrency: number,
    _eventEmitter?: PipelineEventEmitter,
  ): Promise<import("./parallel-worker").ParallelBatchResult> => {
    const { executeParallelBatch } = await import("./parallel-worker");
    return executeParallelBatch(
      _stories,
      _projectRoot,
      _config,
      _context,
      _worktreePaths,
      _maxConcurrency,
      _eventEmitter,
    );
  },

  createWorktreeManager: async () => {
    const { WorktreeManager } = await import("../worktree/manager");
    return new WorktreeManager();
  },

  createMergeEngine: async (worktreeManager: import("../worktree/manager").WorktreeManager) => {
    const { MergeEngine } = await import("../worktree/merge");
    return new MergeEngine(worktreeManager);
  },

  rectifyConflictedStory: async (opts: import("./merge-conflict-rectify").RectifyConflictedStoryOptions) => {
    const { rectifyConflictedStory } = await import("./merge-conflict-rectify");
    return rectifyConflictedStory(opts);
  },
};

/**
 * Run a batch of parallel stories: create worktrees, execute, merge, rectify conflicts.
 */
export async function runParallelBatch(options: RunParallelBatchOptions): Promise<RunParallelBatchResult> {
  const { stories, ctx, prd } = options;
  const { workdir, config, maxConcurrency, pipelineContext, eventEmitter, agentGetFn, hooks, pluginRegistry } = ctx;

  // 1. Create worktree manager and worktrees for each story
  // Record per-story start time at worktree creation (AC-2: worktree creation → merge completion)
  const logger = getSafeLogger();
  const worktreeManager = await _parallelBatchDeps.createWorktreeManager();
  const worktreePaths = new Map<string, string>();
  const storyStartTimes = new Map<string, number>();
  for (const story of stories) {
    storyStartTimes.set(story.id, Date.now());
    try {
      await worktreeManager.create(workdir, story.id);
    } catch (error) {
      logger?.error("parallel-batch", "Failed to create worktree for story", {
        storyId: story.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    worktreePaths.set(story.id, path.join(workdir, ".nax-wt", story.id));
  }

  // 2. Execute all stories in parallel
  const workerResult = await _parallelBatchDeps.executeParallelBatch(
    stories,
    workdir,
    config,
    pipelineContext,
    worktreePaths,
    maxConcurrency,
    eventEmitter,
  );
  // Batch execution complete — record end time for stories resolved in the batch
  const batchEndMs = Date.now();

  // 3. Completed = stories merged to base.
  // Note: we use workerResult.merged (stories that were actually merged to the base branch),
  // NOT workerResult.pipelinePassed (stories that passed tests but may not have merged yet).
  const completed: UserStory[] = workerResult.merged;

  // 4. Failed = stories whose pipeline did not pass.
  // executeParallelBatch returns failed items as { story, error, pipelineResult? }.
  // We always ensure pipelineResult is defined so downstream consumers (e.g. reporter)
  // can rely on it unconditionally. When pipelineResult is absent from the worker result,
  // we synthesize a minimal PipelineRunResult with success=false and the error message.
  const failed: RunParallelBatchResult["failed"] = workerResult.failed.map((f) => ({
    story: f.story,
    pipelineResult: f.pipelineResult ?? {
      success: false,
      finalAction: "fail" as const,
      reason: f.error,
      context: { ...pipelineContext, story: f.story, stories: [f.story], workdir } as PipelineContext,
    },
  }));

  // 5. Rectify merge conflicts sequentially
  // Track per-story end times: conflicts extend past batchEndMs into rectification.
  // Conflict stories are intentionally omitted from the initial loop and handled
  // after rectification so their end times reflect the full rectification duration.
  const storyEndTimes = new Map<string, number>();
  for (const story of [...workerResult.pipelinePassed, ...workerResult.merged]) {
    storyEndTimes.set(story.id, batchEndMs);
  }
  for (const { story } of workerResult.failed) {
    storyEndTimes.set(story.id, batchEndMs);
  }

  const mergeConflicts: RunParallelBatchResult["mergeConflicts"] = [];
  for (const conflict of workerResult.mergeConflicts) {
    const story = stories.find((s) => s.id === conflict.storyId);
    if (!story) continue;

    try {
      const rectResult = await _parallelBatchDeps.rectifyConflictedStory({
        ...conflict,
        workdir,
        config,
        hooks,
        pluginRegistry,
        prd,
        eventEmitter,
        agentGetFn,
      });
      mergeConflicts.push({ story, rectified: rectResult.success, cost: rectResult.cost });
    } catch (err) {
      const logger = getSafeLogger();
      logger?.warn("[parallel-batch]", "rectification failed for story", {
        storyId: story.id,
        error: (err as Error).message,
      });
      mergeConflicts.push({ story, rectified: false, cost: 0 });
    }
    // Record end time after rectification attempt (success or failure)
    storyEndTimes.set(conflict.storyId, Date.now());
  }

  // 6. Costs from worker (not even-split)
  const storyCosts = workerResult.storyCosts;
  const totalCost = [...storyCosts.values()].reduce((sum, c) => sum + c, 0);

  // 7. Build storyDurations: elapsed time from worktree creation to merge/rectification completion
  const storyDurations = new Map<string, number>();
  for (const story of stories) {
    const startMs = storyStartTimes.get(story.id);
    const endMs = storyEndTimes.get(story.id);
    if (startMs !== undefined && endMs !== undefined) {
      storyDurations.set(story.id, endMs - startMs);
    }
  }

  return { completed, failed, mergeConflicts, storyCosts, storyDurations, totalCost };
}
