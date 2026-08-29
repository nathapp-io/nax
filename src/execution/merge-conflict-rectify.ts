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
import type { AgentGetFn, PipelineContext, RoutingResult } from "../pipeline/types";
import type { PluginRegistry } from "../plugins/registry";
import type { PRD, UserStory } from "../prd";
import { typedSpawn } from "../utils/bun-deps";
import { errorMessage } from "../utils/errors";
import { killProcessGroup } from "../utils/process-kill";
import type { MergeResult } from "../worktree";
import { buildWorktreePipelineContext } from "./parallel-worker";

/**
 * Hard deadline on the `acpx sessions close` subprocess. Without this, a wedged
 * acpx (e.g. stuck session broker) blocks the stale-session eviction step and
 * stalls the rectification pipeline indefinitely. Mirrors the SIGKILL-after-
 * timeout pattern from `gitWithTimeout` and `worktree/dependencies.ts`. Tests
 * inject a short value via `_mergeRectifyDeps.timeoutMs`. The eviction remains
 * best-effort — the timeout path returns silently rather than raising, so a
 * dead session broker can never escalate into a rectification failure.
 */
const STALE_SESSION_CLOSE_TIMEOUT_MS = 3_000;

/** Injectable deps for the stale-session eviction step. `typedSpawn` is the
 * dependency that previously lived behind a dynamic import — surfaced here so
 * tests can drive the eviction directly without touching the real acpx. `spawn`
 * is an alias kept for tests that prefer the shorter name. */
export const _mergeRectifyDeps = {
  typedSpawn,
  spawn: typedSpawn,
  killProcessGroup,
  timeoutMs: STALE_SESSION_CLOSE_TIMEOUT_MS,
};

/**
 * Close a stale ACP session by name — best-effort, swallows all errors.
 *
 * Called before rectification to evict sessions from the previous failed run
 * that share the same session name (derived from the same worktree path).
 * Without this, acpx returns exit code 4 (session in bad state) immediately.
 *
 * Bounded by `_mergeRectifyDeps.timeoutMs` so a wedged acpx cannot stall the
 * rectification pipeline — the timeout path falls through to the swallow, so
 * the best-effort contract is preserved end-to-end.
 */
export async function closeStaleAcpSession(worktreePath: string, sessionName: string): Promise<void> {
  const logger = getSafeLogger();
  try {
    const cmd = ["acpx", "--cwd", worktreePath, "claude", "sessions", "close", sessionName];
    logger?.debug("parallel", "Closing stale ACP session before rectification", { sessionName });
    const proc = _mergeRectifyDeps.typedSpawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      // Bun.spawn does not setpgid children into their own group by default, so
      // killProcessGroup(-pid) on timeout would hit ESRCH and fall back to
      // killing only acpx itself (leaving any acpx-session-broker / agent
      // descendants running against a worktree we're about to delete).
      // `detached` makes this process a session/group leader via setsid(),
      // so its own PID IS the real pgid. Matches the established pattern in
      // verification/executor.ts and worktree/dependencies.ts.
      detached: true,
    });

    // Race `proc.exited` against the deadline with a `settled` flag the timer
    // resolves directly — we do NOT rely on SIGKILL causing `proc.exited` to
    // settle, because that side-effect is an implementation detail of the
    // child and not part of the contract this helper guarantees. Mirrors the
    // defensive `awaitProcExit` shape from `src/execution/pid-registry.ts` so
    // AC-5 holds even when the child does not reap its own exited promise
    // after the OS sends SIGKILL.
    let timedOut = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          _mergeRectifyDeps.killProcessGroup(proc.pid, "SIGKILL");
        } catch {
          // Process may have already exited; the deadline below still wins.
        }
        finish();
      }, _mergeRectifyDeps.timeoutMs);
      proc.exited.then(finish, finish);
    });

    if (timedOut) {
      logger?.debug("parallel", "Stale ACP session eviction timed out — swallowed (best-effort)", {
        sessionName,
        timeoutMs: _mergeRectifyDeps.timeoutMs,
      });
    }
  } catch {
    // Best-effort — session may already be gone, or acpx itself may be
    // unavailable in this environment. The deadline above is the only path
    // that lets the eviction settle in finite time.
  }
}

/**
 * Best-effort eviction of stale ACP sessions for the current run.
 *
 * Top-level wrapper for tests (AC-5) and any external caller that needs the
 * eviction contract exposed without knowing the worktree / session naming
 * internals. Spawns a single short-lived `acpx sessions close` against a
 * sentinel session name; the deadline inside `_mergeRectifyDeps.timeoutMs`
 * bounds the call so a wedged acpx cannot stall the rectification pipeline.
 * Resolves (never rejects) — the timeout / spawn-error paths both fall
 * through to a no-op. The worktree path is the project's resolved cwd
 * (resolved through the config/context, not `process.cwd()` per project
 * conventions — see .nax/rules/project-conventions.md).
 */
export async function evictStaleSessions(worktreePath?: string): Promise<void> {
  const cwd = worktreePath ?? ".";
  await closeStaleAcpSession(cwd, "nax-evict-stale-sentinel");
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

    // Step 1: Remove old worktree
    try {
      await worktreeManager.remove(workdir, storyId);
    } catch {
      // Ignore — worktree may have already been removed
    }

    // Step 2: Create fresh worktree from current HEAD
    await worktreeManager.create(workdir, storyId);
    const worktreePath = path.join(workdir, ".nax-wt", storyId);

    // @design: BUG-122: Close stale ACP session from the original failed run before re-running.
    // computeAcpHandle hashes the workdir path — same worktree path = same session name.
    // The old Claude process may still be registered in acpx, causing prompt() to exit
    // with code 4 immediately. Close it explicitly so ensureAcpSession creates fresh.
    const { formatSessionName } = await import("../session/naming");
    const staleSessionName = formatSessionName({
      workdir: worktreePath,
      featureName: prd.feature,
      storyId,
      role: "main",
    });
    await closeStaleAcpSession(worktreePath, staleSessionName);

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
    const mergeResults = await mergeEngine.mergeAll(workdir, [storyId], { [storyId]: [] });
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
