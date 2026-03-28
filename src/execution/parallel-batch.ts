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
 * Stub — implementation is NOT yet provided (RED phase).
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
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
 *
 * NOT YET IMPLEMENTED — stub only.
 */
export async function runParallelBatch(_options: RunParallelBatchOptions): Promise<RunParallelBatchResult> {
  throw new Error("[parallel-batch] runParallelBatch: not yet implemented");
}
