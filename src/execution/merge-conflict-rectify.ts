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
import type { AgentGetFn } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD } from "../prd";
import { errorMessage } from "../utils/errors";

/**
 * Close a stale ACP session by name — best-effort, swallows all errors.
 *
 * Called before rectification to evict sessions from the previous failed run
 * that share the same session name (derived from the same worktree path).
 * Without this, acpx returns exit code 4 (session in bad state) immediately.
 */
async function closeStaleAcpSession(worktreePath: string, sessionName: string): Promise<void> {
  const logger = getSafeLogger();
  try {
    const { typedSpawn } = await import("../utils/bun-deps");
    const cmd = ["acpx", "--cwd", worktreePath, "claude", "sessions", "close", sessionName];
    logger?.debug("parallel", "Closing stale ACP session before rectification", { sessionName });
    const proc = typedSpawn(cmd, { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  } catch {
    // Best-effort — session may already be gone
  }
}

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
  /** Protocol-aware agent resolver. When set (ACP mode), resolves AcpAgentAdapter; falls back to getAgent (CLI) when absent. */
  agentGetFn?: AgentGetFn;
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
  const { storyId, workdir, config, hooks, pluginRegistry, prd, eventEmitter, agentGetFn } = options;
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

    // BUG-122: Close stale ACP session from the original failed run before re-running.
    // buildSessionName hashes the workdir path — same worktree path = same session name.
    // The old Claude process may still be registered in acpx, causing prompt() to exit
    // with code 4 immediately. Close it explicitly so ensureAcpSession creates fresh.
    const { buildSessionName } = await import("../agents/acp/adapter");
    const staleSessionName = buildSessionName(worktreePath, prd.feature, storyId);
    await closeStaleAcpSession(worktreePath, staleSessionName);

    // Step 3: Re-run the story pipeline
    const story = prd.userStories.find((s) => s.id === storyId);
    if (!story) {
      return { success: false, storyId, cost: 0, finalConflict: false, pipelineFailure: true };
    }

    const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, config);

    const pipelineContext = {
      config,
      effectiveConfig: config,
      prd,
      story,
      stories: [story],
      workdir: worktreePath,
      featureDir: undefined,
      hooks,
      plugins: pluginRegistry,
      storyStartTime: new Date().toISOString(),
      routing: routing as import("../pipeline/types").RoutingResult,
      agentGetFn,
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
      error: errorMessage(error),
    });
    return { success: false, storyId, cost: 0, finalConflict: false, pipelineFailure: true };
  }
}
