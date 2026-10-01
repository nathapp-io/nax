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
 * The phase bodies live in ./parallel-batch-phases (B5 of the complexity
 * drain). `runParallelBatch` is the sequencer; `_parallelBatchDeps` STAYS
 * defined here because tests reassign its properties directly on this module
 * — the phases receive it by reference and read `deps.X` at call time, so
 * reassignments before a run still land.
 */

import type { NaxConfig } from "../config";
import { loadConfigForWorkdir } from "../config/loader";
import type { LoadedHooksConfig } from "../hooks";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { PipelineRunResult } from "../pipeline/runner";
import type { AgentGetFn, PipelineContext } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD, UserStory } from "../prd/types";
import { prepareWorktreeDependencies } from "../worktree/dependencies";
import type { WorktreeDependencyContext } from "../worktree/types";
import {
  type BatchFrame,
  buildFailedList,
  createStoryWorktrees,
  executeReadyStories,
  finalizeBatchResult,
  mergePassedStories,
  prepareStoryDependencies,
  rectifyMergeConflicts,
  resolveStoryConfigs,
} from "./parallel-batch-phases";

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
    _dependencyContexts: Map<string, WorktreeDependencyContext>,
    _maxConcurrency: number,
    _eventEmitter?: PipelineEventEmitter,
    _storyEffectiveConfigs?: Map<string, NaxConfig>,
  ): Promise<import("./parallel-worker").ParallelBatchResult> => {
    const { executeParallelBatch } = await import("./parallel-worker");
    return executeParallelBatch(
      _stories,
      _projectRoot,
      _config,
      _context,
      _worktreePaths,
      _dependencyContexts,
      _maxConcurrency,
      _eventEmitter,
      _storyEffectiveConfigs,
    );
  },

  createWorktreeManager: async () => {
    const { WorktreeManager } = await import("../worktree");
    return new WorktreeManager();
  },

  createMergeEngine: async (worktreeManager: import("../worktree").WorktreeManager) => {
    const { MergeEngine } = await import("../worktree");
    return new MergeEngine(worktreeManager);
  },

  rectifyConflictedStory: async (opts: import("./merge-conflict-rectify").RectifyConflictedStoryOptions) => {
    const { rectifyConflictedStory } = await import("./merge-conflict-rectify");
    return rectifyConflictedStory(opts);
  },
  prepareWorktreeDependencies,
  loadConfigForWorkdir,
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
  const frame: BatchFrame = {
    logger,
    worktreeManager,
    worktreePaths: new Map(),
    storyStartTimes: new Map(),
    preExecutionFailures: [],
    preExecutionFailureEndTimes: new Map(),
  };
  await createStoryWorktrees({ workdir, prd, stories, pipelineContext, frame });

  // PKG-003: per-story effective configs (see resolveStoryConfigs).
  const storyEffectiveConfigs = await resolveStoryConfigs({
    deps: _parallelBatchDeps,
    workdir,
    config,
    stories,
    logger,
  });

  // 1b. Dependencies must be ready in each worktree before the workers run.
  const { dependencyContexts, readyStories } = await prepareStoryDependencies({
    deps: _parallelBatchDeps,
    workdir,
    config,
    prd,
    stories,
    pipelineContext,
    storyEffectiveConfigs,
    frame,
  });

  // 2. Execute all stories in parallel
  const workerResult = await executeReadyStories({
    deps: _parallelBatchDeps,
    workdir,
    config,
    maxConcurrency,
    pipelineContext,
    eventEmitter,
    readyStories,
    worktreePaths: frame.worktreePaths,
    dependencyContexts,
    storyEffectiveConfigs,
  });
  // Batch execution complete — record end time for stories resolved in the batch
  const batchEndMs = Date.now();

  // 3. Merge pipeline-passed stories into the base branch in topological order.
  const completed = await mergePassedStories({
    deps: _parallelBatchDeps,
    workdir,
    prd,
    stories,
    workerResult,
    frame,
  });

  // 4. Failed = pre-execution failures + stories whose pipeline did not pass.
  const failed = buildFailedList({
    preExecutionFailures: frame.preExecutionFailures,
    workerResult,
    pipelineContext,
    workdir,
  });

  // 5. Rectify merge conflicts sequentially (also settles every story's end time).
  const { mergeConflicts, storyEndTimes } = await rectifyMergeConflicts({
    deps: _parallelBatchDeps,
    workdir,
    config,
    hooks,
    pluginRegistry,
    prd,
    eventEmitter,
    agentGetFn,
    pipelineContext,
    workerResult,
    failed,
    stories,
    batchEndMs,
    preExecutionFailureEndTimes: frame.preExecutionFailureEndTimes,
  });

  // 6-7. Costs from worker plus rectification spend, and per-story durations.
  const { storyDurations, totalCost } = finalizeBatchResult({
    stories,
    storyStartTimes: frame.storyStartTimes,
    storyEndTimes,
    storyCosts: workerResult.storyCosts,
    mergeConflicts,
  });

  return { completed, failed, mergeConflicts, storyCosts: workerResult.storyCosts, storyDurations, totalCost };
}
