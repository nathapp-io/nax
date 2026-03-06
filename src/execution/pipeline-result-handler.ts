/**
 * Pipeline Result Handlers
 *
 * Extracted from sequential-executor.ts: handles pipeline success, failure,
 * and dry-run outcomes after a story has been executed through the pipeline.
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
import { runPostAgentVerification } from "./post-verify";
import { appendProgress } from "./progress";
import type { StatusWriter } from "./status-writer";

/** Context needed by pipeline result handlers */
export interface PipelineHandlerContext {
  config: import("../config").NaxConfig;
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
  timeoutRetryCountMap: Map<string, number>;
  storyGitRef: string | null | undefined;
  interactionChain?: InteractionChain | null;
}

export interface PipelineSuccessResult {
  storiesCompletedDelta: number;
  costDelta: number;
  prd: PRD;
  prdDirty: boolean;
}

/**
 * Handle a successful pipeline execution:
 * - Post-agent verification
 * - Emit story completion events
 * - Log progress
 */
export async function handlePipelineSuccess(
  ctx: PipelineHandlerContext,
  pipelineResult: PipelineRunResult,
): Promise<PipelineSuccessResult> {
  const logger = getSafeLogger();
  const costDelta = pipelineResult.context.agentResult?.estimatedCost || 0;
  let prd = ctx.prd;

  // Collect story metrics
  if (pipelineResult.context.storyMetrics) {
    ctx.allStoryMetrics.push(...pipelineResult.context.storyMetrics);
  }

  // Post-agent verification
  const verifyResult = await runPostAgentVerification({
    config: ctx.config,
    prd,
    prdPath: ctx.prdPath,
    workdir: ctx.workdir,
    featureDir: ctx.featureDir,
    story: ctx.story,
    storiesToExecute: ctx.storiesToExecute,
    allStoryMetrics: ctx.allStoryMetrics,
    timeoutRetryCountMap: ctx.timeoutRetryCountMap,
  });
  const verificationPassed = verifyResult.passed;
  prd = verifyResult.prd;

  let storiesCompletedDelta = 0;
  if (verificationPassed) {
    storiesCompletedDelta = ctx.storiesToExecute.length;

    for (const completedStory of ctx.storiesToExecute) {
      logger?.info("story.complete", "Story completed successfully", {
        storyId: completedStory.id,
        storyTitle: completedStory.title,
        totalCost: ctx.totalCost + costDelta,
        durationMs: Date.now() - ctx.startTime,
      });

      // Phase 3: emit event — hooks/reporter subscriber handles hook + reporter calls
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
  }

  // Display progress
  const updatedCounts = countStories(prd);
  const elapsedMs = Date.now() - ctx.startTime;
  logger?.info("progress", "Progress update", {
    totalStories: updatedCounts.total,
    passedStories: updatedCounts.passed,
    failedStories: updatedCounts.failed,
    pendingStories: updatedCounts.pending,
    totalCost: ctx.totalCost + costDelta,
    costLimit: ctx.config.execution.costLimit,
    elapsedMs,
  });

  return { storiesCompletedDelta, costDelta, prd, prdDirty: true };
}

export interface PipelineFailureResult {
  prd: PRD;
  prdDirty: boolean;
}

/**
 * Handle a failed pipeline execution based on finalAction:
 * pause, skip, fail, or escalate.
 */
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

      logger?.warn("pipeline", "Story paused", {
        storyId: ctx.story.id,
        reason: pipelineResult.reason,
      });

      // Phase 3: emit event — hooks/reporter subscriber handles hook + reporter calls
      pipelineEventBus.emit({
        type: "story:paused",
        storyId: ctx.story.id,
        reason: pipelineResult.reason || "Pipeline paused",
        cost: ctx.totalCost,
      });
      break;

    case "skip":
      logger?.warn("pipeline", "Story skipped", {
        storyId: ctx.story.id,
        reason: pipelineResult.reason,
      });
      prdDirty = true;

      // Note: no dedicated "story:skipped" event yet; skip is uncommon
      // TODO Phase 4: add story:skipped event to event bus
      break;

    case "fail":
      markStoryFailed(prd, ctx.story.id, pipelineResult.context.tddFailureCategory);
      await savePRD(prd, ctx.prdPath);
      prdDirty = true;

      logger?.error("pipeline", "Story failed", {
        storyId: ctx.story.id,
        reason: pipelineResult.reason,
      });

      if (ctx.featureDir) {
        await appendProgress(ctx.featureDir, ctx.story.id, "failed", `${ctx.story.title} — ${pipelineResult.reason}`);
      }

      // Phase 3: emit events — hooks/reporter/interaction subscribers handle the rest
      pipelineEventBus.emit({
        type: "story:failed",
        storyId: ctx.story.id,
        story: ctx.story,
        reason: pipelineResult.reason || "Pipeline failed",
        countsTowardEscalation: true,
        feature: ctx.feature,
        attempts: ctx.story.attempts,
      });

      // Emit human-review request if max retries exceeded
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

/**
 * Apply cached routing overrides from story.routing to a fresh routing decision.
 */
export function applyCachedRouting(
  routing: ReturnType<typeof routeTask>,
  story: UserStory,
  config: NaxConfig,
): ReturnType<typeof routeTask> {
  if (!story.routing) return routing;
  const overrides: Partial<ReturnType<typeof routeTask>> = {};
  if (story.routing.complexity) {
    overrides.complexity = story.routing.complexity;
  }
  // BUG-013 fix: Use story.routing.modelTier directly if present (set by escalation).
  // Only derive from complexity if modelTier is not explicitly set.
  if (story.routing.modelTier) {
    overrides.modelTier = story.routing.modelTier as ReturnType<typeof routeTask>["modelTier"];
  } else if (story.routing.complexity) {
    const tierFromComplexity = config.autoMode.complexityRouting[story.routing.complexity] ?? "balanced";
    overrides.modelTier = tierFromComplexity as ReturnType<typeof routeTask>["modelTier"];
  }
  if (story.routing.testStrategy) {
    overrides.testStrategy = story.routing.testStrategy;
  }
  return { ...routing, ...overrides };
}

/** Context for dry-run iteration handling */
export interface DryRunContext {
  prd: PRD;
  prdPath: string;
  storiesToExecute: UserStory[];
  routing: ReturnType<typeof routeTask>;
  statusWriter: StatusWriter;
  pluginRegistry: PluginRegistry;
  runId: string;
  totalCost: number;
  iterations: number;
}

export interface DryRunResult {
  storiesCompletedDelta: number;
  prdDirty: boolean;
}

/** Handle dry-run iteration: log what would happen, mark stories passed. */
export async function handleDryRun(ctx: DryRunContext): Promise<DryRunResult> {
  const logger = getSafeLogger();

  ctx.statusWriter.setPrd(ctx.prd);
  ctx.statusWriter.setCurrentStory({
    storyId: ctx.storiesToExecute[0].id,
    title: ctx.storiesToExecute[0].title,
    complexity: ctx.routing.complexity,
    tddStrategy: ctx.routing.testStrategy,
    model: ctx.routing.modelTier,
    attempt: (ctx.storiesToExecute[0].attempts ?? 0) + 1,
    phase: "routing",
  });
  await ctx.statusWriter.update(ctx.totalCost, ctx.iterations);

  for (const s of ctx.storiesToExecute) {
    logger?.info("execution", "[DRY RUN] Would execute agent here", {
      storyId: s.id,
      storyTitle: s.title,
      modelTier: ctx.routing.modelTier,
      complexity: ctx.routing.complexity,
      testStrategy: ctx.routing.testStrategy,
    });
  }

  // Mark stories as passed so the loop progresses
  for (const s of ctx.storiesToExecute) {
    const { markStoryPassed } = await import("../prd");
    markStoryPassed(ctx.prd, s.id);
  }
  await savePRD(ctx.prd, ctx.prdPath);

  // Emit onStoryComplete events for dry-run
  for (const s of ctx.storiesToExecute) {
    // Phase 3: emit event — reporter subscriber handles onStoryComplete
    pipelineEventBus.emit({
      type: "story:completed",
      storyId: s.id,
      story: s,
      passed: true,
      durationMs: 0,
      cost: 0,
      modelTier: ctx.routing.modelTier,
      testStrategy: ctx.routing.testStrategy,
    });
  }

  ctx.statusWriter.setPrd(ctx.prd);
  ctx.statusWriter.setCurrentStory(null);
  await ctx.statusWriter.update(ctx.totalCost, ctx.iterations);

  return { storiesCompletedDelta: ctx.storiesToExecute.length, prdDirty: true };
}
