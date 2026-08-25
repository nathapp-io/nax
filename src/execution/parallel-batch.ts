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
import { profileOverrideFromConfig } from "../config";
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
  const worktreePaths = new Map<string, string>();
  const storyStartTimes = new Map<string, number>();
  // Contained per-story like every other failure path below (preExecutionFailures is
  // declared here, not further down, so this loop can push into it too) — one story's
  // worktree-creation failure must not abort the whole batch and strand the worktrees
  // already created for its siblings (BUG-05). A synthesized failure matches the shape
  // the dependency-prep loop already produces below.
  const preExecutionFailures: RunParallelBatchResult["failed"] = [];
  // Failure timestamp captured at the moment each pre-execution failure actually
  // happens, not at batchEndMs (which is stamped after every surviving sibling
  // finishes) — otherwise an instant worktree-create failure reports a duration
  // spanning the whole batch's wall-clock time in storyDurations.
  const preExecutionFailureEndTimes = new Map<string, number>();
  for (const story of stories) {
    storyStartTimes.set(story.id, Date.now());
    try {
      await worktreeManager.create(workdir, story.id);
    } catch (error) {
      logger?.error("parallel-batch", "Failed to create worktree for story", {
        storyId: story.id,
        error: error instanceof Error ? error.message : String(error),
      });
      preExecutionFailures.push({
        story,
        pipelineResult: {
          success: false,
          finalAction: "fail",
          reason: error instanceof Error ? error.message : String(error),
          stoppedAtStage: "worktree-create",
          context: { ...pipelineContext, story, stories: [story], workdir } as PipelineContext,
        },
      });
      preExecutionFailureEndTimes.set(story.id, Date.now());
      continue;
    }
    worktreePaths.set(story.id, path.join(workdir, ".nax-wt", story.id));
  }

  // PKG-003 (parallel): Resolve per-story effective configs so per-package quality/review
  // command overrides apply in parallel mode (same as iteration-runner does for sequential).
  // Without this, all parallel stories use the root config regardless of story.workdir.
  // allSettled so a single malformed per-package config doesn't crash the whole batch.
  const rootConfigPath = path.join(workdir, ".nax", "config.json");
  const profileOverride = profileOverrideFromConfig(config);
  const storyEffectiveConfigs = new Map<string, NaxConfig>();
  const configResults = await Promise.allSettled(
    stories
      .filter((story) => story.workdir)
      .map(async (story) => {
        try {
          const effectiveConfig = await _parallelBatchDeps.loadConfigForWorkdir(
            rootConfigPath,
            story.workdir as string,
            profileOverride,
          );
          return { storyId: story.id, effectiveConfig };
        } catch (err) {
          // Enrich the error so the rejection carries the storyId for logging.
          const enriched = new Error(err instanceof Error ? err.message : String(err));
          (enriched as NodeJS.ErrnoException & { storyId?: string }).storyId = story.id;
          throw enriched;
        }
      }),
  );
  for (const result of configResults) {
    if (result.status === "fulfilled") {
      storyEffectiveConfigs.set(result.value.storyId, result.value.effectiveConfig);
    } else {
      const storyId = (result.reason as { storyId?: string })?.storyId ?? "(unknown)";
      logger?.warn("parallel-batch", "Failed to load per-story config; using root config", {
        storyId,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  const dependencyContexts = new Map<string, WorktreeDependencyContext>();
  const readyStories: UserStory[] = [];
  for (const story of stories) {
    const worktreeRoot = worktreePaths.get(story.id);
    if (!worktreeRoot) continue;

    const effectiveConfig = storyEffectiveConfigs.get(story.id) ?? config;
    try {
      const dependencyContext = await _parallelBatchDeps.prepareWorktreeDependencies({
        projectRoot: workdir,
        worktreeRoot,
        storyId: story.id,
        storyWorkdir: story.workdir,
        config: effectiveConfig,
      });
      dependencyContexts.set(story.id, dependencyContext);
      readyStories.push(story);
    } catch (error) {
      preExecutionFailures.push({
        story,
        pipelineResult: {
          success: false,
          finalAction: "fail",
          reason: error instanceof Error ? error.message : String(error),
          stoppedAtStage: "worktree-dependencies",
          context: { ...pipelineContext, story, stories: [story], workdir: worktreeRoot } as PipelineContext,
        },
      });
      // Record the failure timestamp now, matching the worktree-create failure
      // path above — without this, storyEndTimes falls back to batchEndMs for
      // dependency-prep failures, reporting a duration spanning the whole
      // batch's wall-clock time instead of the actual (near-instant) failure.
      preExecutionFailureEndTimes.set(story.id, Date.now());
      try {
        await worktreeManager.remove(workdir, story.id);
      } catch {
        // best-effort cleanup
      }
    }
  }

  // 2. Execute all stories in parallel
  const workerResult: import("./parallel-worker").ParallelBatchResult =
    readyStories.length > 0
      ? await _parallelBatchDeps.executeParallelBatch(
          readyStories,
          workdir,
          config,
          pipelineContext,
          worktreePaths,
          dependencyContexts,
          maxConcurrency,
          eventEmitter,
          storyEffectiveConfigs.size > 0 ? storyEffectiveConfigs : undefined,
        )
      : {
          pipelinePassed: [],
          merged: [],
          failed: [],
          totalCost: 0,
          mergeConflicts: [],
          storyCosts: new Map(),
        };
  // Batch execution complete — record end time for stories resolved in the batch
  const batchEndMs = Date.now();

  // 3. Merge pipeline-passed stories into the base branch in topological order.
  // parallel-worker.ts only populates pipelinePassed (pipeline success) and merged=[].
  // We must call mergeEngine.mergeAll here so that worktree branches are integrated
  // into the project root before acceptance/regression stages run.
  const completed: UserStory[] = [];
  if (workerResult.pipelinePassed.length > 0) {
    const mergeEngine = await _parallelBatchDeps.createMergeEngine(worktreeManager);
    const successfulIds = workerResult.pipelinePassed.map((s) => s.id);
    // Build dependency map for topological merge ordering
    const deps: Record<string, string[]> = {};
    for (const s of stories) deps[s.id] = s.dependencies ?? [];

    const mergeResults = await mergeEngine.mergeAll(workdir, successfulIds, deps);

    for (const mergeResult of mergeResults) {
      const story = workerResult.pipelinePassed.find((s) => s.id === mergeResult.storyId);
      if (!story) continue;

      if (mergeResult.success) {
        completed.push(story);
        workerResult.merged.push(story);
        logger?.info("parallel-batch", "Story merged successfully", {
          storyId: mergeResult.storyId,
        });
      } else if (mergeResult.failureKind === "error") {
        // Non-conflict merge failure. Nothing for rectification to resolve, so treat
        // it as a plain story failure rather than buying an agent session for it.
        // Only an explicit "error" lands here — an unlabelled failure keeps the
        // historical conflict path so no caller silently loses rectification.
        workerResult.failed.push({ story, error: mergeResult.error ?? "merge failed" });
        logger?.error("parallel-batch", "Merge failed for a non-conflict reason", {
          storyId: mergeResult.storyId,
          error: mergeResult.error,
        });
      } else {
        // Merge conflict — move to mergeConflicts for rectification below
        workerResult.mergeConflicts.push({
          storyId: mergeResult.storyId,
          conflictFiles: mergeResult.conflictFiles || [],
          originalCost: workerResult.storyCosts.get(mergeResult.storyId) ?? 0,
        });
        logger?.warn("parallel-batch", "Merge conflict — will attempt rectification", {
          storyId: mergeResult.storyId,
          conflictFiles: mergeResult.conflictFiles,
        });
      }
    }
  }

  // 4. Failed = stories whose pipeline did not pass.
  // executeParallelBatch returns failed items as { story, error, pipelineResult? }.
  // We always ensure pipelineResult is defined so downstream consumers (e.g. reporter)
  // can rely on it unconditionally. When pipelineResult is absent from the worker result,
  // we synthesize a minimal PipelineRunResult with success=false and the error message.
  const failed: RunParallelBatchResult["failed"] = [
    ...preExecutionFailures,
    ...workerResult.failed.map((f) => ({
      story: f.story,
      pipelineResult: f.pipelineResult ?? {
        success: false,
        finalAction: "fail" as const,
        reason: f.error,
        context: { ...pipelineContext, story: f.story, stories: [f.story], workdir } as PipelineContext,
      },
    })),
  ];

  // 5. Rectify merge conflicts sequentially
  // Track per-story end times: conflicts extend past batchEndMs into rectification.
  // Conflict stories are intentionally omitted from the initial loop and handled
  // after rectification so their end times reflect the full rectification duration.
  const storyEndTimes = new Map<string, number>();
  for (const story of [...workerResult.pipelinePassed, ...workerResult.merged]) {
    storyEndTimes.set(story.id, batchEndMs);
  }
  for (const { story } of failed) {
    storyEndTimes.set(story.id, preExecutionFailureEndTimes.get(story.id) ?? batchEndMs);
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
        // BUG-36: reuse the same worktree-pipeline base the workers ran with, so the
        // rectification re-run inherits the identical worktree contract (skipPrdPersistence,
        // prdPath, featureDir, cost/session wiring) instead of a hand-rolled subset that
        // silently drifts whenever a field is added to one side and not the other.
        pipelineContextBase: pipelineContext,
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

  // 6. Costs from worker (not even-split) plus rectification spend (BUG-37) — a
  // rectified story's full re-run cost lands only in mergeConflicts[].cost, never
  // in storyCosts, so the batch total previously under-reported it.
  const storyCosts = workerResult.storyCosts;
  const totalCost =
    [...storyCosts.values()].reduce((sum, c) => sum + c, 0) + mergeConflicts.reduce((sum, c) => sum + c.cost, 0);

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
