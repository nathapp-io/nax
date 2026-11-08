/**
 * Pipeline Result Handlers (ADR-005, Phase 4)
 *
 * Handles pipeline success, failure outcomes after story execution.
 * Dry-run handling: see execution/dry-run.ts
 * applyCachedRouting: removed (P4-001 — pipeline routing stage is sole source)
 */

import { existsSync } from "node:fs";
import { gitSpawnEnv } from "@nathapp/nax-agent/internal";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { spawn } from "@/utils/bun-deps";
import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import type { InteractionChain } from "../interaction/chain";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineRunResult } from "../pipeline/runner";
import type { PluginRegistry } from "../plugins";
import type { PostRunStatusWriter } from "../prd";
import { countStories, markStoryFailed, markStoryPaused, savePrdProgress } from "../prd";
import type { PRD, UserStory } from "../prd/types";
import type { routeTask } from "../routing";
import { storySpendUsd } from "../runtime";
import type { DispatchContext } from "../runtime/dispatch-context";
import { captureDiffSummary, captureOutputFiles } from "../utils/git";
import { storyPackageDir } from "../utils/path-frame";
import {
  deriveStoryWorktreeId,
  naxOrphanRefName,
  storyBranchName,
  storyWorktreePath,
  WorktreeManager,
} from "../worktree";
import { handleTierEscalation, verifyEscalationQuotes } from "./escalation";
import { appendProgress } from "./progress";

/** Injectable deps for testability */
export const _resultHandlerDeps = {
  spawn,
  existsSync,
  savePrdProgress,
  worktreeManager: new WorktreeManager(),
  handleTierEscalation,
};

/**
 * MEM-6: parallel-batch dispatch creates a worktree for every story unconditionally, so
 * cleanup must key off whether one actually exists rather than off a config mode that
 * creation ignored. Runs that never create a worktree leave this false and behaviour is
 * unchanged.
 */
function hasWorktree(projectRoot: string, worktreeId: import("../worktree").WorktreeId): boolean {
  return _resultHandlerDeps.existsSync(storyWorktreePath(projectRoot, worktreeId));
}

/**
 * EXEC-002: Remove a worktree directory from git's worktree tracking without deleting
 * the branch. This preserves `nax/<storyId>` in git for diagnostics and re-run cleanup
 * while reclaiming disk space. Best-effort — errors are logged but not thrown.
 *
 * US-002: On a successful removal, additionally record nax ownership of the
 * surviving branch by writing `refs/nax/orphan/<storyId>` to point at the
 * branch tip. The retry path consumes this ref as Step-3 evidence so the
 * next `WorktreeManager.create()` can force-delete the branch. The record
 * lives in the same git store as the thing it describes and is removed with
 * `git update-ref -d` in the same step that deletes the branch — so it
 * cannot outlive what it records. A user branch named `nax/<storyId>` that
 * nax never created never acquires one, so BUG-28's user-branch guard is
 * unchanged.
 */
async function removeWorktreeDirectory(
  projectRoot: string,
  worktreeId: import("../worktree").WorktreeId,
): Promise<boolean> {
  const logger = getSafeLogger();
  const worktreePath = storyWorktreePath(projectRoot, worktreeId);
  try {
    const proc = _resultHandlerDeps.spawn(["git", "worktree", "remove", worktreePath, "--force"], {
      cwd: projectRoot,
      env: gitSpawnEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    // BUG-12: drain both streams concurrently with the exit so a git error
    // emitting >64KB cannot block the child on a full pipe buffer, and so
    // non-zero exits are observable instead of invisible.
    // BUG-3: bind all three tuple elements — the previous `const [exitCode,
    // stderr]` aliased the second tuple element (stdout) to `stderr` and
    // silently dropped the real stderr, so genuine git errors were invisible
    // while stdout (usually empty) got logged as "stderr".
    const [exitCode, _stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ] as const);
    if (exitCode !== 0) {
      logger?.warn("worktree", "Failed to remove worktree directory (non-fatal)", {
        worktreeId,
        worktreePath,
        exitCode,
        stderr: stderr.slice(0, 500),
      });
      return false;
    }
    return true;
  } catch (error) {
    logger?.warn("worktree", "Failed to remove worktree directory (non-fatal)", {
      worktreeId,
      worktreePath,
      error: String(error),
    });
    return false;
  }
}

/**
 * US-002: Write `refs/nax/orphan/<worktreeId>` to point at the surviving
 * `nax/<worktreeId>` branch tip. Best-effort: a non-zero exit logs at warn on
 * stage `worktree` (carrying `worktreeId`) and returns — matches the existing
 * contract of `removeWorktreeDirectory` above.
 *
 * The writer here is the only US-002-mandated cross-cuts in
 * `pipeline-result-handler.ts`: the failure paths must produce the COMPOSED
 * orphan ref (pair with `WorktreeManager.create`'s composed read) so a
 * retry that consumes the ref can match. The composition is done at the
 * call site via `deriveStoryWorktreeId(ctx.feature, ctx.story.id)`;
 * `feature` is in the pipeline handler context. Earlier direct
 * interpolation of `<storyId>` in the writer would have written a
 * dangling ref the manager would never consume.
 */
async function recordNaxOrphanOwnership(
  projectRoot: string,
  worktreeId: import("../worktree").WorktreeId,
): Promise<void> {
  const logger = getSafeLogger();
  const orphanRef = naxOrphanRefName(worktreeId);
  const sourceBranch = `refs/heads/${storyBranchName(worktreeId)}`;
  try {
    const proc = _resultHandlerDeps.spawn(["git", "update-ref", orphanRef, sourceBranch], {
      cwd: projectRoot,
      env: gitSpawnEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, _stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ] as const);
    if (exitCode !== 0) {
      logger?.warn("worktree", "Failed to record nax orphan ownership ref (non-fatal)", {
        worktreeId,
        orphanRef,
        sourceBranch,
        exitCode,
        stderr: stderr.slice(0, 500),
      });
    }
  } catch (error) {
    logger?.warn("worktree", "Failed to record nax orphan ownership ref (non-fatal)", {
      worktreeId,
      orphanRef,
      sourceBranch,
      error: String(error),
    });
  }
}

/** Filter noise from output files (test files, lock files, nax runtime files) */
function filterOutputFiles(files: string[]): string[] {
  const NOISE = [
    /\.test\.(ts|js|tsx|jsx)$/,
    /\.spec\.(ts|js|tsx|jsx)$/,
    /package-lock\.json$/,
    /bun\.lock(b?)$/,
    /\.gitignore$/,
    /^nax\//,
  ];
  return files.filter((f) => !NOISE.some((p) => p.test(f))).slice(0, 15);
}

export interface PipelineHandlerContext extends DispatchContext {
  config: NaxConfig;
  prd: PRD;
  prdPath: string;
  workdir: string;
  featureDir?: string;
  hooks: LoadedHooksConfig;
  feature: string;
  totalCost: number;
  startTime: number;
  runId: string;
  pluginRegistry: PluginRegistry;
  story: UserStory;
  storiesToExecute: UserStory[];
  routing: ReturnType<typeof routeTask>;
  isBatchExecution: boolean;
  allStoryMetrics: StoryMetrics[];
  storyGitRef: string | null | undefined;
  interactionChain?: InteractionChain | null;
  storyStartTime?: number;
  statusWriter?: PostRunStatusWriter;
}

export interface PipelineSuccessResult {
  storiesCompletedDelta: number;
  costDelta: number;
  prd: PRD;
  prdDirty: boolean;
}

export async function handlePipelineSuccess(
  ctx: PipelineHandlerContext,
  pipelineResult: PipelineRunResult,
): Promise<PipelineSuccessResult> {
  const logger = getSafeLogger();
  const costDelta = (pipelineResult.context.agentResult?.estimatedCostUsd ?? 0) + (pipelineResult.stageCost ?? 0);
  const prd = ctx.prd;

  if (pipelineResult.context.storyMetrics) {
    ctx.allStoryMetrics.push(...pipelineResult.context.storyMetrics);
  }

  const storiesCompletedDelta = ctx.storiesToExecute.length;
  for (const completedStory of ctx.storiesToExecute) {
    const now = Date.now();
    logger?.info("story.complete", "Story completed successfully", {
      storyId: completedStory.id,
      storyTitle: completedStory.title,
      totalCost: ctx.totalCost + costDelta,
      runElapsedMs: now - ctx.startTime,
      storyDurationMs: ctx.storyStartTime ? now - ctx.storyStartTime : undefined,
    });

    // @design: BUG-074: story:completed event is already emitted by completion stage
    // (src/pipeline/stages/completion.ts). Do NOT emit again here — it causes
    // duplicate hook messages (on-story-complete fires twice per story).
  }

  // ENH-005: Capture output files + diff summary for context chaining
  if (ctx.storyGitRef) {
    for (const completedStory of ctx.storiesToExecute) {
      try {
        const rawFiles = await captureOutputFiles(ctx.workdir, ctx.storyGitRef, storyPackageDir(completedStory));
        const filtered = filterOutputFiles(rawFiles);
        if (filtered.length > 0) {
          completedStory.outputFiles = filtered;
        }
        // Capture diff stat summary for dependency context injection.
        // Note: if the agent commits at session-close time (after pipeline stages complete),
        // HEAD may still equal storyGitRef here and the diff will be empty.
        const diffSummary = await captureDiffSummary(ctx.workdir, ctx.storyGitRef, storyPackageDir(completedStory));
        if (diffSummary) {
          completedStory.diffSummary = diffSummary;
        } else {
          logger?.debug("context-chain", "No diff summary captured (agent may not have committed yet)", {
            storyId: completedStory.id,
            storyGitRef: ctx.storyGitRef,
          });
        }
      } catch {
        // Non-fatal — context chaining is best-effort
      }
    }
  }

  const updatedCounts = countStories(prd);
  logger?.info("progress", "Progress update", {
    totalStories: updatedCounts.total,
    passedStories: updatedCounts.passed,
    failedStories: updatedCounts.failed,
    pendingStories: updatedCounts.pending,
    totalCost: ctx.totalCost + costDelta,
    costLimit: ctx.config.execution.costLimit,
    elapsedMs: Date.now() - ctx.startTime,
    storyDurationMs: ctx.storyStartTime ? Date.now() - ctx.storyStartTime : undefined,
  });

  return { storiesCompletedDelta, costDelta, prd, prdDirty: true };
}

export interface PipelineFailureResult {
  prd: PRD;
  prdDirty: boolean;
  costDelta: number;
}

export async function handlePipelineFailure(
  ctx: PipelineHandlerContext,
  pipelineResult: PipelineRunResult,
): Promise<PipelineFailureResult> {
  const logger = getSafeLogger();
  let prd = ctx.prd;
  let prdDirty = false;
  // Always capture cost even for failed stories — agent ran and spent tokens
  const costDelta = (pipelineResult.context.agentResult?.estimatedCostUsd ?? 0) + (pipelineResult.stageCost ?? 0);

  switch (pipelineResult.finalAction) {
    case "pause": {
      // nax#1582: persist the blocking reason so the resume prompt and the
      // resumed agent's context aren't left with "no reason recorded".
      // Quote-scrub first — the reason can carry LLM-sourced text.
      const rawPauseReason = pipelineResult.reason ?? "";
      const pauseReason = rawPauseReason
        ? await verifyEscalationQuotes(rawPauseReason, ctx.workdir, ctx.story.id)
        : rawPauseReason;
      markStoryPaused(prd, ctx.story.id, pauseReason || undefined);
      await _resultHandlerDeps.savePrdProgress(prd, ctx.prdPath, ctx.story.id, "paused");
      prdDirty = true;
      logger?.warn("pipeline", "Story paused", { storyId: ctx.story.id, reason: pipelineResult.reason });
      // EXEC-002: Remove worktree directory on pause (keep branch for diagnostics).
      // US-002: Pause path does NOT write the orphan ref — only the fail
      // path does. Writing it here would make a later resume silently
      // discard the WIP branch via Step-3, instead of failing loudly at
      // `worktree add -b`.
      const pauseWorktreeId = deriveStoryWorktreeId(ctx.feature, ctx.story.id);
      if (hasWorktree(ctx.workdir, pauseWorktreeId)) {
        await removeWorktreeDirectory(ctx.workdir, pauseWorktreeId);
      }
      const spend = storySpendUsd(ctx.runtime.costAggregator, ctx.story.id, ctx.totalCost);
      pipelineEventBus.emit({
        type: "story:paused",
        storyId: ctx.story.id,
        reason: pipelineResult.reason || "Pipeline paused",
        cost: spend.cost,
        ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
      });
      break;
    }

    case "skip":
      logger?.warn("pipeline", "Story skipped", { storyId: ctx.story.id, reason: pipelineResult.reason });
      pipelineEventBus.emit({
        type: "story:skipped",
        storyId: ctx.story.id,
        reason: pipelineResult.reason || "Story skipped",
      });
      prdDirty = true;
      break;

    case "fail": {
      markStoryFailed(prd, ctx.story.id, pipelineResult.stoppedAtStage, ctx.statusWriter);
      await _resultHandlerDeps.savePrdProgress(prd, ctx.prdPath, ctx.story.id, "failed");
      prdDirty = true;
      logger?.error("pipeline", "Story failed", { storyId: ctx.story.id, reason: pipelineResult.reason });
      // EXEC-002: All tiers exhausted — remove the worktree directory but keep the branch
      // (nax/<worktreeId>) so the failed commits are preserved for diagnostics and re-run cleanup.
      //
      // US-002: On a successful removal, additionally record nax ownership of
      // the surviving branch by writing `refs/nax/orphan/<worktreeId>` to point
      // at the branch tip. The retry path consumes this ref as Step-3 evidence
      // so the next `WorktreeManager.create()` can force-delete the branch.
      // The record lives in the same git store as the thing it describes and
      // is removed with `git update-ref -d` in the same step that deletes the
      // branch — so it cannot outlive what it records.
      //
      // The orphan ref is scoped to the fail path. The pause path does NOT
      // write it (preserving the "keep branch for diagnostics" promise on
      // resume). A failed `git worktree remove` does NOT write it either —
      // the branch is still checked out in a (surviving) live worktree, so
      const failWorktreeId = deriveStoryWorktreeId(ctx.feature, ctx.story.id);
      // claiming nax owns an orphan would be a false record that misleads
      // the next create().
      if (hasWorktree(ctx.workdir, failWorktreeId)) {
        const removeSucceeded = await removeWorktreeDirectory(ctx.workdir, failWorktreeId);
        if (removeSucceeded) {
          await recordNaxOrphanOwnership(ctx.workdir, failWorktreeId);
        }
        logger?.info("worktree", "Kept failed story branch", {
          storyId: ctx.story.id,
          branch: storyBranchName(failWorktreeId),
        });
      }

      if (ctx.featureDir) {
        await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — ${pipelineResult.reason}`);
      }

      const spend = storySpendUsd(ctx.runtime.costAggregator, ctx.story.id, ctx.totalCost);
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: ctx.story.id,
        story: { id: ctx.story.id, title: ctx.story.title, status: ctx.story.status, attempts: ctx.story.attempts },
        reason: pipelineResult.reason || "Pipeline failed",
        countsTowardEscalation: true,
        feature: ctx.feature,
        attempts: ctx.story.attempts,
        cost: spend.cost,
        ...(spend.errorCostUsd > 0 ? { errorCostUsd: spend.errorCostUsd } : {}),
      });

      if (
        ctx.story.attempts !== undefined &&
        ctx.story.attempts >= ctx.config.execution.rectification.maxAttemptsTotal
      ) {
        await pipelineEventBus.emitAsync({
          type: "human-review:requested",
          storyId: ctx.story.id,
          reason: pipelineResult.reason || "Max retries exceeded",
          feature: ctx.feature,
          attempts: ctx.story.attempts,
        });
      }
      break;
    }

    case "escalate": {
      const escalationResult = await _resultHandlerDeps.handleTierEscalation({
        story: ctx.story,
        storiesToExecute: ctx.storiesToExecute,
        isBatchExecution: ctx.isBatchExecution,
        routing: ctx.routing,
        pipelineResult,
        config: ctx.config,
        prd,
        prdPath: ctx.prdPath,
        featureDir: ctx.featureDir,
        hooks: ctx.hooks,
        feature: ctx.feature,
        totalCost: ctx.totalCost,
        workdir: ctx.workdir,
        attemptCost: pipelineResult.context.agentResult?.estimatedCostUsd || 0,
        agentManager: ctx.agentManager,
        runtime: ctx.runtime,
      });
      prd = escalationResult.prd;
      prdDirty = escalationResult.prdDirty;
      break;
    }

    // Listed so the switch is exhaustive over PipelineRunResult["finalAction"]
    // rather than falling through silently. Neither reaches here: this function
    // is entered only when `pipelineResult.success` is false (see
    // iteration-runner.ts), and "complete" is the sole action the pipeline
    // pairs with success — while "decomposed" is declared on the union but no
    // stage produces it.
    case "complete":
    case "decomposed":
      break;
  }

  return { prd, prdDirty, costDelta };
}
