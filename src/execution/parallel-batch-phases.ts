/**
 * Phases of runParallelBatch, extracted from parallel-batch.ts (B5 of the
 * cognitive-complexity drain).
 *
 * The test-injection seam (`_parallelBatchDeps`) STAYS defined in
 * parallel-batch.ts — every phase receives it BY REFERENCE on its input and
 * reads `deps.X` at call time, so tests that reassign the seam's properties
 * (unit, structure, and integration mirrors) still land. This file imports
 * parallel-batch.ts TYPE-ONLY; the runtime edge is sequencer → phases only.
 *
 * Shared mutable accumulators live in one `BatchFrame` created by the
 * sequencer and mutated IN PLACE by the phases — the original pushed into
 * these maps/arrays across loops, and every `Date.now()` call stays at the
 * exact position the monolith had it (per-story start at loop top, failure
 * stamps at the failure moment, batch end right after the worker returns).
 */

import path from "node:path";
import type { NaxConfig } from "../config";
import { profileOverrideFromConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { AgentGetFn, PipelineContext } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD, UserStory } from "../prd/types";
import { storyPackageDir } from "../utils/path-frame";
import { deriveStoryWorktreeId, storyWorktreePath, type WorktreeManager } from "../worktree";
import type { WorktreeDependencyContext } from "../worktree/types";
import type { _parallelBatchDeps, RunParallelBatchResult } from "./parallel-batch";
import type { ParallelBatchResult } from "./parallel-worker";

/** The per-story execution deps, threaded by reference (test seam — do not copy). */
export type ParallelBatchDeps = typeof _parallelBatchDeps;

/** Logger as returned by getSafeLogger (undefined when nothing initialized it). */
type BatchLogger = ReturnType<typeof getSafeLogger>;

/**
 * Accumulators shared by the batch phases, mutated in place.
 *
 * `preExecutionFailures` is declared up front (not further down) so the
 * worktree-creation loop and the dependency-prep loop can both push into it —
 * one story's pre-execution failure must not abort the whole batch and strand
 * the worktrees already created for its siblings (BUG-05). A synthesized
 * failure matches the shape the dependency-prep loop produces below.
 *
 * `preExecutionFailureEndTimes` captures the timestamp at the moment each
 * pre-execution failure actually happens, not at batchEndMs (which is stamped
 * after every surviving sibling finishes) — otherwise an instant
 * worktree-create failure reports a duration spanning the whole batch's
 * wall-clock time in storyDurations.
 */
export interface BatchFrame {
  logger: BatchLogger;
  worktreeManager: WorktreeManager;
  worktreePaths: Map<string, string>;
  storyStartTimes: Map<string, number>;
  preExecutionFailures: RunParallelBatchResult["failed"];
  preExecutionFailureEndTimes: Map<string, number>;
}

/**
 * Phase 1 — create a worktree per story (BUG-05: per-story failures are
 * contained), recording per-story start times at creation (AC-2: worktree
 * creation → merge completion).
 */
export async function createStoryWorktrees(input: {
  workdir: string;
  prd: PRD;
  stories: UserStory[];
  pipelineContext: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">;
  frame: BatchFrame;
}): Promise<void> {
  const { workdir, prd, stories, pipelineContext, frame } = input;
  for (const story of stories) {
    frame.storyStartTimes.set(story.id, Date.now());
    // US-003: compose the worktree identity from the run's feature and the
    // story's raw id, so `create()` — and every spelling built from it below —
    // names the same `.nax-wt/story-<feature>-<storyId>` directory the
    // workers and the result handler look for.
    const worktreeId = deriveStoryWorktreeId(prd.feature, story.id);
    try {
      await frame.worktreeManager.create(workdir, worktreeId);
    } catch (error) {
      frame.logger?.error("parallel-batch", "Failed to create worktree for story", {
        storyId: story.id,
        error: error instanceof Error ? error.message : String(error),
      });
      frame.preExecutionFailures.push({
        story,
        pipelineResult: {
          success: false,
          finalAction: "fail",
          reason: error instanceof Error ? error.message : String(error),
          stoppedAtStage: "worktree-create",
          context: { ...pipelineContext, story, stories: [story], workdir } as PipelineContext,
        },
      });
      frame.preExecutionFailureEndTimes.set(story.id, Date.now());
      continue;
    }
    frame.worktreePaths.set(story.id, storyWorktreePath(workdir, worktreeId));
  }
}

/**
 * PKG-003 (parallel): Resolve per-story effective configs so per-package quality/review
 * command overrides apply in parallel mode (same as iteration-runner does for sequential).
 * Without this, all parallel stories use the root config regardless of story.workdir.
 * allSettled so a single malformed per-package config doesn't crash the whole batch.
 */
export async function resolveStoryConfigs(input: {
  deps: ParallelBatchDeps;
  workdir: string;
  config: NaxConfig;
  stories: UserStory[];
  logger: BatchLogger;
}): Promise<Map<string, NaxConfig>> {
  const { deps, workdir, config, stories, logger } = input;
  const rootConfigPath = path.join(workdir, ".nax", "config.json");
  const profileOverride = profileOverrideFromConfig(config);
  const storyEffectiveConfigs = new Map<string, NaxConfig>();
  const configResults = await Promise.allSettled(
    stories
      .filter((story) => storyPackageDir(story))
      .map(async (story) => {
        try {
          const effectiveConfig = await deps.loadConfigForWorkdir(
            rootConfigPath,
            storyPackageDir(story) as string,
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
  return storyEffectiveConfigs;
}

/**
 * Phase 3 — prepare worktree dependencies per story; failures are contained
 * (BUG-05 shape) and clean up the story's worktree (US-003 identity).
 */
export async function prepareStoryDependencies(input: {
  deps: ParallelBatchDeps;
  workdir: string;
  config: NaxConfig;
  prd: PRD;
  stories: UserStory[];
  pipelineContext: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">;
  storyEffectiveConfigs: Map<string, NaxConfig>;
  frame: BatchFrame;
}): Promise<{ dependencyContexts: Map<string, WorktreeDependencyContext>; readyStories: UserStory[] }> {
  const { deps, workdir, config, prd, stories, pipelineContext, storyEffectiveConfigs, frame } = input;
  const dependencyContexts = new Map<string, WorktreeDependencyContext>();
  const readyStories: UserStory[] = [];
  for (const story of stories) {
    const worktreeRoot = frame.worktreePaths.get(story.id);
    if (!worktreeRoot) continue;

    const effectiveConfig = storyEffectiveConfigs.get(story.id) ?? config;
    try {
      const dependencyContext = await deps.prepareWorktreeDependencies({
        projectRoot: workdir,
        worktreeRoot,
        storyId: story.id,
        storyWorkdir: storyPackageDir(story),
        config: effectiveConfig,
      });
      dependencyContexts.set(story.id, dependencyContext);
      readyStories.push(story);
    } catch (error) {
      frame.preExecutionFailures.push({
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
      frame.preExecutionFailureEndTimes.set(story.id, Date.now());
      try {
        // US-003: the same identity `create()` was given, so cleanup names the
        // directory that actually exists.
        await frame.worktreeManager.remove(workdir, deriveStoryWorktreeId(prd.feature, story.id));
      } catch {
        // best-effort cleanup
      }
    }
  }
  return { dependencyContexts, readyStories };
}

/** Phase 4 — execute all ready stories in parallel (or nothing when none are ready). */
export async function executeReadyStories(input: {
  deps: ParallelBatchDeps;
  workdir: string;
  config: NaxConfig;
  maxConcurrency: number;
  pipelineContext: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">;
  eventEmitter?: PipelineEventEmitter;
  readyStories: UserStory[];
  worktreePaths: Map<string, string>;
  dependencyContexts: Map<string, WorktreeDependencyContext>;
  storyEffectiveConfigs: Map<string, NaxConfig>;
}): Promise<ParallelBatchResult> {
  const {
    deps,
    workdir,
    config,
    maxConcurrency,
    pipelineContext,
    eventEmitter,
    readyStories,
    worktreePaths,
    dependencyContexts,
    storyEffectiveConfigs,
  } = input;
  return readyStories.length > 0
    ? await deps.executeParallelBatch(
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
}

/**
 * Phase 5 — merge pipeline-passed stories into the base branch in topological order.
 * parallel-worker.ts only populates pipelinePassed (pipeline success) and merged=[].
 * We must call mergeEngine.mergeAll here so that worktree branches are integrated
 * into the project root before acceptance/regression stages run.
 */
export async function mergePassedStories(input: {
  deps: ParallelBatchDeps;
  workdir: string;
  prd: PRD;
  stories: UserStory[];
  workerResult: ParallelBatchResult;
  frame: BatchFrame;
}): Promise<UserStory[]> {
  const { deps: batchDeps, workdir, prd, stories, workerResult, frame } = input;
  const completed: UserStory[] = [];
  if (workerResult.pipelinePassed.length > 0) {
    const mergeEngine = await batchDeps.createMergeEngine(frame.worktreeManager);
    const successfulIds = workerResult.pipelinePassed.map((s) => s.id);
    // Build dependency map for topological merge ordering
    const deps: Record<string, string[]> = {};
    for (const s of stories) deps[s.id] = s.dependencies ?? [];

    // US-003: `storyId` stays raw — it is the merge-order key `deps` is indexed
    // by — while the branch each entry merges is the composed identity.
    const successfulStories = successfulIds.map((id) => ({
      storyId: id,
      worktreeId: deriveStoryWorktreeId(prd.feature, id),
    }));
    const mergeResults = await mergeEngine.mergeAll(workdir, successfulStories, deps);

    for (const mergeResult of mergeResults) {
      const story = workerResult.pipelinePassed.find((s) => s.id === mergeResult.storyId);
      if (!story) continue;

      if (mergeResult.success) {
        completed.push(story);
        workerResult.merged.push(story);
        frame.logger?.info("parallel-batch", "Story merged successfully", {
          storyId: mergeResult.storyId,
        });
      } else if (mergeResult.failureKind === "error") {
        // Non-conflict merge failure. Nothing for rectification to resolve, so treat
        // it as a plain story failure rather than buying an agent session for it.
        // Only an explicit "error" lands here — an unlabelled failure keeps the
        // historical conflict path so no caller silently loses rectification.
        workerResult.failed.push({ story, error: mergeResult.error ?? "merge failed" });
        frame.logger?.error("parallel-batch", "Merge failed for a non-conflict reason", {
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
        frame.logger?.warn("parallel-batch", "Merge conflict — will attempt rectification", {
          storyId: mergeResult.storyId,
          conflictFiles: mergeResult.conflictFiles,
        });
      }
    }
  }
  return completed;
}

/**
 * Phase 6 — failed = stories whose pipeline did not pass.
 * executeParallelBatch returns failed items as { story, error, pipelineResult? }.
 * We always ensure pipelineResult is defined so downstream consumers (e.g. reporter)
 * can rely on it unconditionally. When pipelineResult is absent from the worker result,
 * we synthesize a minimal PipelineRunResult with success=false and the error message.
 */
export function buildFailedList(input: {
  preExecutionFailures: RunParallelBatchResult["failed"];
  workerResult: ParallelBatchResult;
  pipelineContext: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">;
  workdir: string;
}): RunParallelBatchResult["failed"] {
  const { preExecutionFailures, workerResult, pipelineContext, workdir } = input;
  return [
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
}

/**
 * Phase 7 — rectify merge conflicts sequentially.
 * Per-story end times: conflicts extend past batchEndMs into rectification.
 * Conflict stories are intentionally omitted from the initial loop and handled
 * after rectification so their end times reflect the full rectification duration.
 */
export async function rectifyMergeConflicts(input: {
  deps: ParallelBatchDeps;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  pluginRegistry: PluginRegistry;
  prd: PRD;
  eventEmitter?: PipelineEventEmitter;
  agentGetFn?: AgentGetFn;
  pipelineContext: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">;
  workerResult: ParallelBatchResult;
  failed: RunParallelBatchResult["failed"];
  stories: UserStory[];
  batchEndMs: number;
  preExecutionFailureEndTimes: Map<string, number>;
}): Promise<{
  mergeConflicts: RunParallelBatchResult["mergeConflicts"];
  storyEndTimes: Map<string, number>;
}> {
  const { deps, workdir, config, hooks, pluginRegistry, prd, eventEmitter, agentGetFn, pipelineContext } = input;
  const { workerResult, failed, stories, batchEndMs } = input;
  const storyEndTimes = new Map<string, number>();
  for (const story of [...workerResult.pipelinePassed, ...workerResult.merged]) {
    storyEndTimes.set(story.id, batchEndMs);
  }
  for (const { story } of failed) {
    storyEndTimes.set(story.id, input.preExecutionFailureEndTimes.get(story.id) ?? batchEndMs);
  }

  const mergeConflicts: RunParallelBatchResult["mergeConflicts"] = [];
  for (const conflict of workerResult.mergeConflicts) {
    const story = stories.find((s) => s.id === conflict.storyId);
    if (!story) continue;

    try {
      const rectResult = await deps.rectifyConflictedStory({
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
  return { mergeConflicts, storyEndTimes };
}

/**
 * Phase 8 — costs from worker (not even-split) plus rectification spend (BUG-37) — a
 * rectified story's full re-run cost lands only in mergeConflicts[].cost, never
 * in storyCosts, so the batch total previously under-reported it — and the
 * storyDurations map (elapsed from worktree creation to merge/rectification completion).
 */
export function finalizeBatchResult(input: {
  stories: UserStory[];
  storyStartTimes: Map<string, number>;
  storyEndTimes: Map<string, number>;
  storyCosts: Map<string, number>;
  mergeConflicts: RunParallelBatchResult["mergeConflicts"];
}): { storyDurations: Map<string, number>; totalCost: number } {
  const { stories, storyStartTimes, storyEndTimes, storyCosts, mergeConflicts } = input;
  const totalCost =
    [...storyCosts.values()].reduce((sum, c) => sum + c, 0) + mergeConflicts.reduce((sum, c) => sum + c.cost, 0);

  const storyDurations = new Map<string, number>();
  for (const story of stories) {
    const startMs = storyStartTimes.get(story.id);
    const endMs = storyEndTimes.get(story.id);
    if (startMs !== undefined && endMs !== undefined) {
      storyDurations.set(story.id, endMs - startMs);
    }
  }
  return { storyDurations, totalCost };
}
