/**
 * Conflict Rectification Logic
 *
 * Handles re-running a single conflicted story on the updated base branch
 * so it sees all previously merged stories (MFX-005).
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { AgentGetFn, PipelineContext, RoutingResult } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD, UserStory } from "../prd";
import { deriveNativeTranscriptDir } from "../session/manager-deps";
import type { MergeResult } from "../worktree";
import { deriveStoryWorktreeId, storyWorktreePath } from "../worktree";
import { buildWorktreePipelineContext } from "./parallel-worker";

/**
 * Injectable deps for the stale-session discard (BUG-122). The ACP module is
 * imported lazily, like this file's other heavy imports, to keep execution/
 * out of the agents/acp import graph.
 */
export const _mergeRectifyDeps = {
  discardStaleSession: async (transcriptDir: string | undefined, name: string): Promise<void> => {
    const { discardAcpSessionLeftover } = await import("../agents/acp");
    await discardAcpSessionLeftover(transcriptDir, name);
  },
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

/**
 * Build the failure result for a post-rectification merge that did not land.
 *
 * `finalConflict` used to be hardcoded `true` here, which was the last place
 * still guessing: after #1533 the merge engine reports *why* it failed, and a
 * dirty tree or a missing branch is not a conflict the agent failed to resolve.
 * Telling the operator otherwise sends them looking for a conflict that was
 * never there.
 *
 * Only an explicit `"error"` clears the flag. An absent result, or one from a
 * merge engine predating `failureKind`, keeps the historical conflict reading.
 */
export function rectifyMergeFailure(
  storyId: string,
  cost: number,
  mergeResult: MergeResult | undefined,
): RectificationResult {
  return {
    success: false,
    storyId,
    cost,
    finalConflict: mergeResult?.failureKind !== "error",
    conflictFiles: mergeResult?.conflictFiles ?? [],
  };
}

/** Options passed to rectifyConflictedStory */
export interface RectifyConflictedStoryOptions extends ConflictedStoryInfo {
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  pluginRegistry: PluginRegistry;
  prd: PRD;
  eventEmitter?: PipelineEventEmitter;
  /** Protocol-aware agent resolver. When set (ACP mode), resolves AcpAgentAdapter; falls back to getAgent (CLI) when absent. */
  agentGetFn?: AgentGetFn;
  /**
   * The same worktree-pipeline base the worker ran with (BUG-36). Carries the
   * worktree contract — skipPrdPersistence, prdPath, featureDir, agentManager,
   * sessionManager, runtime, abortSignal — so the rectification re-run can never
   * silently drift from the worker's context: a field added to one flows to both
   * because both build from this same object via buildWorktreePipelineContext.
   */
  pipelineContextBase: Omit<PipelineContext, "story" | "stories" | "workdir" | "routing" | "storyGitRef">;
}

/**
 * Build the PipelineContext for a rectification re-run (BUG-36).
 *
 * Pulled out of rectifyConflictedStory as a pure function so the worktree-contract
 * fields (skipPrdPersistence, prdPath, featureDir, agentManager/sessionManager/
 * runtime/abortSignal) flowing through from `pipelineContextBase` — and
 * `skipCompletionEvents` being forced on — can be asserted directly in a unit
 * test, without mocking runPipeline/WorktreeManager/MergeEngine.
 */
export function buildRectificationPipelineContext(options: {
  pipelineContextBase: RectifyConflictedStoryOptions["pipelineContextBase"];
  story: UserStory;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  pluginRegistry: PluginRegistry;
  workdir: string;
  worktreePath: string;
  routing: RoutingResult;
  agentGetFn?: AgentGetFn;
}): PipelineContext {
  const { pipelineContextBase, story, config, hooks, pluginRegistry, workdir, worktreePath, routing, agentGetFn } =
    options;
  return {
    ...buildWorktreePipelineContext(pipelineContextBase, story),
    config,
    rootConfig: config,
    story,
    stories: [story],
    projectDir: workdir,
    workdir: worktreePath,
    hooks,
    plugins: pluginRegistry,
    storyStartTime: new Date().toISOString(),
    routing,
    agentGetFn: agentGetFn ?? pipelineContextBase.agentGetFn,
    skipCompletionEvents: true, // BUG-36: the worker's first pass already emitted story:completed
  };
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
export async function rectifyConflictedStory(options: RectifyConflictedStoryOptions): Promise<RectificationResult> {
  const { storyId, workdir, config, hooks, pluginRegistry, prd, eventEmitter, agentGetFn, pipelineContextBase } =
    options;
  const logger = getSafeLogger();

  logger?.info("parallel", "Rectifying story on updated base", { storyId, attempt: "rectification" });

  try {
    const { WorktreeManager } = await import("../worktree");
    const { MergeEngine } = await import("../worktree");
    const { runPipeline } = await import("../pipeline/runner");
    const { defaultPipeline } = await import("../pipeline/stages");
    const { routeTask } = await import("../routing");

    const worktreeManager = new WorktreeManager();
    const mergeEngine = new MergeEngine(worktreeManager);

    // US-003: compose the identity once from the run's feature and the raw story
    // id — remove(), create(), the working directory and the merge must all name
    // the same `.nax-wt/story-<feature>-<storyId>` worktree / branch pair.
    const worktreeId = deriveStoryWorktreeId(prd.feature, storyId);

    // Step 1: Remove old worktree
    try {
      await worktreeManager.remove(workdir, worktreeId);
    } catch {
      // Ignore — worktree may have already been removed
    }

    // Step 2: Create fresh worktree from current HEAD
    await worktreeManager.create(workdir, worktreeId);
    const worktreePath = storyWorktreePath(workdir, worktreeId);

    // @design: BUG-122: the failed run's session must not carry into the re-run.
    // The session name hashes the worktree path, so the re-run reuses it, and a
    // crash-leftover transcript under that name would be resumed at open. Discard
    // it so the session opens fresh. Best-effort: never fails the rectification.
    const { formatSessionName } = await import("../session/naming");
    const staleSessionName = formatSessionName({
      workdir: worktreePath,
      featureName: prd.feature,
      storyId,
      role: "main",
    });
    const transcriptDir = deriveNativeTranscriptDir({
      featureName: prd.feature,
      transcriptRoot: pipelineContextBase.runtime.outputDir,
    });
    await _mergeRectifyDeps.discardStaleSession(transcriptDir, staleSessionName).catch(() => {});

    // Step 3: Re-run the story pipeline
    const story = prd.userStories.find((s) => s.id === storyId);
    if (!story) {
      return { success: false, storyId, cost: 0, finalConflict: false, pipelineFailure: true };
    }

    const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);

    // BUG-36: built from the same worktree-pipeline base the worker ran with, via the
    // one shared builder (parallel-worker.ts), instead of a hand-rolled object literal
    // that previously omitted skipPrdPersistence/prdPath and mutated the shared PRD.
    const pipelineContext = buildRectificationPipelineContext({
      pipelineContextBase,
      story,
      config,
      hooks,
      pluginRegistry,
      workdir,
      worktreePath,
      routing: routing as RoutingResult,
      agentGetFn,
    });

    const pipelineResult = await runPipeline(defaultPipeline, pipelineContext, eventEmitter);
    const cost = pipelineResult.context.agentResult?.estimatedCostUsd ?? 0;

    if (!pipelineResult.success) {
      logger?.info("parallel", "Rectification failed - preserving worktree", { storyId });
      return { success: false, storyId, cost, finalConflict: false, pipelineFailure: true };
    }

    // Step 4: Attempt merge on updated base
    const mergeResults = await mergeEngine.mergeAll(workdir, [{ storyId, worktreeId }], { [storyId]: [] });
    const mergeResult = mergeResults[0];

    if (!mergeResult?.success) {
      logger?.info("parallel", "Rectification failed - preserving worktree", {
        storyId,
        failureKind: mergeResult?.failureKind,
        error: mergeResult?.error,
      });
      return rectifyMergeFailure(storyId, cost, mergeResult);
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
      error: errorMessage(error),
    });
    return { success: false, storyId, cost: 0, finalConflict: false, pipelineFailure: true };
  }
}
