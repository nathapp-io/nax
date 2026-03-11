/**
 * Conflict Rectification Logic
 *
 * Handles re-running a single conflicted story on the updated base branch
 * so it sees all previously merged stories (MFX-005).
 */

import path from "node:path";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import { getSafeLogger } from "../logger";
import type { PipelineEventEmitter } from "../pipeline/events";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD } from "../prd";

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

/** Options passed to rectifyConflictedStory */
export interface RectifyConflictedStoryOptions extends ConflictedStoryInfo {
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  pluginRegistry: PluginRegistry;
  prd: PRD;
  eventEmitter?: PipelineEventEmitter;
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
  const { storyId, workdir, config, hooks, pluginRegistry, prd, eventEmitter } = options;
  const logger = getSafeLogger();

  logger?.info("parallel", "Rectifying story on updated base", { storyId, attempt: "rectification" });

  try {
    const { WorktreeManager } = await import("../worktree/manager");
    const { MergeEngine } = await import("../worktree/merge");
    const { runPipeline } = await import("../pipeline/runner");
    const { defaultPipeline } = await import("../pipeline/stages");
    const { routeTask } = await import("../routing");

    const worktreeManager = new WorktreeManager();
    const mergeEngine = new MergeEngine(worktreeManager);

    // Step 1: Remove old worktree
    try {
      await worktreeManager.remove(workdir, storyId);
    } catch {
      // Ignore — worktree may have already been removed
    }

    // Step 2: Create fresh worktree from current HEAD
    await worktreeManager.create(workdir, storyId);
    const worktreePath = path.join(workdir, ".nax-wt", storyId);

    // Step 3: Re-run the story pipeline
    const story = prd.userStories.find((s) => s.id === storyId);
    if (!story) {
      return { success: false, storyId, cost: 0, finalConflict: false, pipelineFailure: true };
    }

    const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);

    const pipelineContext = {
      config,
      prd,
      story,
      stories: [story],
      workdir: worktreePath,
      featureDir: undefined,
      hooks,
      plugins: pluginRegistry,
      storyStartTime: new Date().toISOString(),
      routing: routing as import("../pipeline/types").RoutingResult,
    };

    const pipelineResult = await runPipeline(defaultPipeline, pipelineContext, eventEmitter);
    const cost = pipelineResult.context.agentResult?.estimatedCost ?? 0;

    if (!pipelineResult.success) {
      logger?.info("parallel", "Rectification failed - preserving worktree", { storyId });
      return { success: false, storyId, cost, finalConflict: false, pipelineFailure: true };
    }

    // Step 4: Attempt merge on updated base
    const mergeResults = await mergeEngine.mergeAll(workdir, [storyId], { [storyId]: [] });
    const mergeResult = mergeResults[0];

    if (!mergeResult || !mergeResult.success) {
      const conflictFiles = mergeResult?.conflictFiles ?? [];
      logger?.info("parallel", "Rectification failed - preserving worktree", { storyId });
      return { success: false, storyId, cost, finalConflict: true, conflictFiles };
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
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, storyId, cost: 0, finalConflict: false, pipelineFailure: true };
  }
}
