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
import { handleTierEscalation } from "./escalation";
import { appendProgress } from "./progress";

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
    logger?.info("story.complete", "Story completed successfully", {
      storyId: completedStory.id,
      storyTitle: completedStory.title,
      totalCost: ctx.totalCost + costDelta,
      durationMs: Date.now() - ctx.startTime,
    });

    pipelineEventBus.emit({
      type: "story:completed",
      storyId: completedStory.id,
      story: completedStory,
      passed: true,
      durationMs: Date.now() - ctx.startTime,
      cost: costDelta,
      modelTier: ctx.routing.modelTier,
      testStrategy: ctx.routing.testStrategy,
    });
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
  });

  return { storiesCompletedDelta, costDelta, prd, prdDirty: true };
}

export interface PipelineFailureResult {
  prd: PRD;
  prdDirty: boolean;
}

export async function handlePipelineFailure(
  ctx: PipelineHandlerContext,
  pipelineResult: PipelineRunResult,
): Promise<PipelineFailureResult> {
  const logger = getSafeLogger();
  let prd = ctx.prd;
  let prdDirty = false;

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
      markStoryFailed(prd, ctx.story.id, pipelineResult.context.tddFailureCategory);
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
        pipelineEventBus.emit({
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
      });
      prd = escalationResult.prd;
      prdDirty = escalationResult.prdDirty;
      break;
    }
  }

  return { prd, prdDirty };
}
