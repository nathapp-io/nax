/**
 * Pipeline Result Handlers (ADR-005, Phase 4)
 *
 * Handles pipeline success, failure outcomes after story execution.
 * Dry-run handling: see execution/dry-run.ts
 * applyCachedRouting: removed (P4-001 — pipeline routing stage is sole source)
 */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import type { InteractionChain } from "../interaction/chain";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { pipelineEventBus } from "../pipeline/event-bus";
import type { PipelineRunResult } from "../pipeline/runner";
import type { PluginRegistry } from "../plugins";
import { countStories, markStoryFailed, markStoryPaused, savePRD } from "../prd";
import type { PRD, UserStory } from "../prd/types";
import type { routeTask } from "../routing";
import { captureDiffSummary, captureOutputFiles } from "../utils/git";
import { handleTierEscalation } from "./escalation";
import { appendProgress } from "./progress";

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

export interface PipelineHandlerContext {
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
  const costDelta = pipelineResult.context.agentResult?.estimatedCost || 0;
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

    // BUG-074: story:completed event is already emitted by completion stage
    // (src/pipeline/stages/completion.ts). Do NOT emit again here — it causes
    // duplicate hook messages (on-story-complete fires twice per story).
  }

  // ENH-005: Capture output files + diff summary for context chaining
  if (ctx.storyGitRef) {
    for (const completedStory of ctx.storiesToExecute) {
      try {
        const rawFiles = await captureOutputFiles(ctx.workdir, ctx.storyGitRef, completedStory.workdir);
        const filtered = filterOutputFiles(rawFiles);
        if (filtered.length > 0) {
          completedStory.outputFiles = filtered;
        }
        // Capture diff stat summary for dependency context injection
        const diffSummary = await captureDiffSummary(ctx.workdir, ctx.storyGitRef, completedStory.workdir);
        if (diffSummary) {
          completedStory.diffSummary = diffSummary;
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
  const costDelta = pipelineResult.context.agentResult?.estimatedCost || 0;

  switch (pipelineResult.finalAction) {
    case "pause":
      markStoryPaused(prd, ctx.story.id);
      await savePRD(prd, ctx.prdPath);
      prdDirty = true;
      logger?.warn("pipeline", "Story paused", { storyId: ctx.story.id, reason: pipelineResult.reason });
      pipelineEventBus.emit({
        type: "story:paused",
        storyId: ctx.story.id,
        reason: pipelineResult.reason || "Pipeline paused",
        cost: ctx.totalCost,
      });
      break;

    case "skip":
      logger?.warn("pipeline", "Story skipped", { storyId: ctx.story.id, reason: pipelineResult.reason });
      prdDirty = true;
      break;

    case "fail":
      markStoryFailed(prd, ctx.story.id, pipelineResult.context.tddFailureCategory, pipelineResult.stoppedAtStage);
      await savePRD(prd, ctx.prdPath);
      prdDirty = true;
      logger?.error("pipeline", "Story failed", { storyId: ctx.story.id, reason: pipelineResult.reason });

      if (ctx.featureDir) {
        await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — ${pipelineResult.reason}`);
      }

      pipelineEventBus.emit({
        type: "story:failed",
        storyId: ctx.story.id,
        story: ctx.story,
        reason: pipelineResult.reason || "Pipeline failed",
        countsTowardEscalation: true,
        feature: ctx.feature,
        attempts: ctx.story.attempts,
      });

      if (ctx.story.attempts !== undefined && ctx.story.attempts >= ctx.config.execution.rectification.maxRetries) {
        await pipelineEventBus.emitAsync({
          type: "human-review:requested",
          storyId: ctx.story.id,
          reason: pipelineResult.reason || "Max retries exceeded",
          feature: ctx.feature,
          attempts: ctx.story.attempts,
        });
      }
      break;

    case "escalate": {
      const escalationResult = await handleTierEscalation({
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
        attemptCost: pipelineResult.context.agentResult?.estimatedCost || 0,
      });
      prd = escalationResult.prd;
      prdDirty = escalationResult.prdDirty;
      break;
    }
  }

  return { prd, prdDirty, costDelta };
}
