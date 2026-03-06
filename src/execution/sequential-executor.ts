/** Sequential Story Executor — main execution loop for story pipeline. */

import type { NaxConfig } from "../config";
import type { LoadedHooksConfig } from "../hooks";
import type { InteractionChain } from "../interaction/chain";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { pipelineEventBus } from "../pipeline/event-bus";
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import { wireHooks } from "../pipeline/subscribers/hooks";
import { wireInteraction } from "../pipeline/subscribers/interaction";
import { wireReporters } from "../pipeline/subscribers/reporters";
import type { PipelineContext, RoutingResult } from "../pipeline/types";
import type { PluginRegistry } from "../plugins";
import { generateHumanHaltSummary, getNextStory, isComplete, isStalled, loadPRD } from "../prd";
import type { PRD, UserStory } from "../prd/types";
import { captureGitRef } from "../utils/git";
import type { StoryBatch } from "./batching";
import { startHeartbeat, stopHeartbeat, writeExitSummary } from "./crash-recovery";
import { handleDryRun, handlePipelineFailure, handlePipelineSuccess } from "./pipeline-result-handler";
import type { StatusWriter } from "./status-writer";

/**
 * P4-001: Build a preview routing from cached story.routing or config defaults.
 * The pipeline routing stage will perform full LLM/keyword classification and overwrite ctx.routing.
 * This preview is used only for pre-pipeline logging, status display, and event emission.
 */
function buildPreviewRouting(story: UserStory, config: NaxConfig): RoutingResult {
  const cached = story.routing;
  const defaultComplexity = "medium" as const;
  const defaultTier = "balanced" as const;
  const defaultStrategy = "test-after" as const;
  return {
    complexity: (cached?.complexity as RoutingResult["complexity"]) ?? defaultComplexity,
    modelTier:
      (cached?.modelTier as RoutingResult["modelTier"]) ??
      (config.autoMode.complexityRouting?.[defaultComplexity] as RoutingResult["modelTier"]) ??
      defaultTier,
    testStrategy: (cached?.testStrategy as RoutingResult["testStrategy"]) ?? defaultStrategy,
    reasoning: cached ? "cached from story.routing" : "preview (pending pipeline routing stage)",
  };
}

export interface SequentialExecutionContext {
  prdPath: string;
  workdir: string;
  config: NaxConfig;
  hooks: LoadedHooksConfig;
  feature: string;
  featureDir?: string;
  dryRun: boolean;
  useBatch: boolean;
  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  statusWriter: StatusWriter;
  logFilePath?: string;
  runId: string;
  startTime: number;
  batchPlan: StoryBatch[];
  interactionChain?: InteractionChain | null;
}

export interface SequentialExecutionResult {
  prd: PRD;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  allStoryMetrics: StoryMetrics[];
  exitReason: "completed" | "cost-limit" | "max-iterations" | "stalled" | "no-stories";
}

/**
 * Execute stories sequentially through the pipeline
 */
export async function executeSequential(
  ctx: SequentialExecutionContext,
  initialPrd: PRD,
): Promise<SequentialExecutionResult> {
  const logger = getSafeLogger();
  let prd = initialPrd;
  let prdDirty = false;
  let iterations = 0;
  let storiesCompleted = 0;
  let totalCost = 0;
  const allStoryMetrics: StoryMetrics[] = [];
  let currentBatchIndex = 0;
  let lastStoryId: string | null = null;

  // Phase 3: Wire singleton event bus with fresh subscribers each run
  pipelineEventBus.clear();
  wireHooks(pipelineEventBus, ctx.hooks, ctx.workdir, ctx.feature);
  wireReporters(pipelineEventBus, ctx.pluginRegistry, ctx.runId, ctx.startTime);
  wireInteraction(pipelineEventBus, ctx.interactionChain, ctx.config);

  const buildResult = (exitReason: SequentialExecutionResult["exitReason"]): SequentialExecutionResult => ({
    prd,
    iterations,
    storiesCompleted,
    totalCost,
    allStoryMetrics,
    exitReason,
  });

  startHeartbeat(
    ctx.statusWriter,
    () => totalCost,
    () => iterations,
    ctx.logFilePath,
  );

  try {
    // Main execution loop
    while (iterations < ctx.config.execution.maxIterations) {
      iterations++;

      // MEM-1: Check memory usage (warn if > 1GB heap)
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      if (heapUsedMB > 1024) {
        logger?.warn("execution", "High memory usage detected", {
          heapUsedMB,
          suggestion: "Consider pausing (echo PAUSE > .queue.txt) if this continues to grow",
        });
      }

      // Reload PRD only if dirty (modified since last load)
      if (prdDirty) {
        prd = await loadPRD(ctx.prdPath);
        prdDirty = false;
      }

      // Check completion
      if (isComplete(prd)) {
        logger?.info("execution", "All stories complete!", {
          feature: ctx.feature,
          totalCost,
        });
        pipelineEventBus.emit({
          type: "run:completed",
          totalStories: 0,
          passedStories: 0,
          failedStories: 0,
          durationMs: Date.now() - ctx.startTime,
          totalCost,
        });
        return buildResult("completed");
      }

      // Get next story/batch
      let storiesToExecute: UserStory[];
      let isBatchExecution: boolean;
      let story: UserStory;
      let routing: RoutingResult;

      if (ctx.useBatch && currentBatchIndex < ctx.batchPlan.length) {
        // Get next batch from precomputed plan
        const batch = ctx.batchPlan[currentBatchIndex];
        currentBatchIndex++;

        // Filter out already-completed stories
        storiesToExecute = batch.stories.filter(
          (s) =>
            !s.passes &&
            s.status !== "passed" &&
            s.status !== "skipped" &&
            s.status !== "blocked" &&
            s.status !== "failed" &&
            s.status !== "paused",
        );
        isBatchExecution = batch.isBatch && storiesToExecute.length > 1;

        if (storiesToExecute.length === 0) {
          // All stories in this batch already completed, move to next batch
          continue;
        }

        // Use first story as the primary story for routing/context
        story = storiesToExecute[0];
        // P4-001: Build preview routing from cached story.routing (pipeline routing stage does full classification)
        routing = buildPreviewRouting(story, ctx.config);
      } else {
        // Fallback to single-story mode (when batching disabled or batch plan exhausted)
        const nextStory = getNextStory(prd, lastStoryId, ctx.config.execution.rectification?.maxRetries ?? 2);
        if (!nextStory) {
          logger?.warn("execution", "No actionable stories (check dependencies)");
          return buildResult("no-stories");
        }

        story = nextStory;
        lastStoryId = story.id;
        storiesToExecute = [story];
        isBatchExecution = false;

        // P4-001: Build preview routing from cached story.routing (pipeline routing stage does full classification)
        routing = buildPreviewRouting(story, ctx.config);
      }

      // Check cost limit
      if (totalCost >= ctx.config.execution.costLimit) {
        logger?.warn("execution", "Cost limit reached, pausing", {
          totalCost,
          costLimit: ctx.config.execution.costLimit,
        });
        pipelineEventBus.emit({
          type: "run:paused",
          reason: `Cost limit reached: $${totalCost.toFixed(2)}`,
          storyId: story.id,
          cost: totalCost,
        });
        return buildResult("cost-limit");
      }

      logger?.info("iteration.start", `Starting iteration ${iterations}`, {
        iteration: iterations,
        storyId: story.id,
        storyTitle: story.title,
        isBatch: isBatchExecution,
        batchSize: isBatchExecution ? storiesToExecute.length : 1,
        modelTier: routing.modelTier,
        complexity: routing.complexity,
        ...(isBatchExecution && { batchStoryIds: storiesToExecute.map((s) => s.id) }),
      });

      // Phase 3: emit story started event
      pipelineEventBus.emit({
        type: "story:started",
        storyId: story.id,
        story,
        workdir: ctx.workdir,
        modelTier: routing.modelTier,
        agent: ctx.config.autoMode.defaultAgent,
        iteration: iterations,
      });

      if (ctx.dryRun) {
        const dryRunResult = await handleDryRun({
          prd,
          prdPath: ctx.prdPath,
          storiesToExecute,
          routing,
          statusWriter: ctx.statusWriter,
          pluginRegistry: ctx.pluginRegistry,
          runId: ctx.runId,
          totalCost,
          iterations,
        });
        storiesCompleted += dryRunResult.storiesCompletedDelta;
        prdDirty = dryRunResult.prdDirty;
        continue;
      }

      // Capture git ref for scoped verification
      const storyGitRef = await captureGitRef(ctx.workdir);

      // Build pipeline context
      const storyStartTime = new Date().toISOString();
      const pipelineContext: PipelineContext = {
        config: ctx.config,
        prd,
        story,
        stories: storiesToExecute,
        routing: routing as RoutingResult,
        workdir: ctx.workdir,
        featureDir: ctx.featureDir,
        hooks: ctx.hooks,
        plugins: ctx.pluginRegistry,
        storyStartTime,
        storyGitRef: storyGitRef ?? undefined, // FEAT-010: per-attempt baseRef for precise smart-runner diff
        interaction: ctx.interactionChain ?? undefined,
      };

      // Log agent start
      logger?.info("agent.start", "Starting agent execution", {
        storyId: story.id,
        agent: ctx.config.autoMode.defaultAgent,
        modelTier: routing.modelTier,
        testStrategy: routing.testStrategy,
        isBatch: isBatchExecution,
      });

      // Update status before execution
      ctx.statusWriter.setPrd(prd);
      ctx.statusWriter.setCurrentStory({
        storyId: story.id,
        title: story.title,
        complexity: routing.complexity,
        tddStrategy: routing.testStrategy,
        model: routing.modelTier,
        attempt: (story.attempts ?? 0) + 1,
        phase: "routing",
      });
      await ctx.statusWriter.update(totalCost, iterations);

      // Run pipeline
      const pipelineResult = await runPipeline(defaultPipeline, pipelineContext, ctx.eventEmitter);

      // Log agent complete
      logger?.info("agent.complete", "Agent execution completed", {
        storyId: story.id,
        success: pipelineResult.success,
        finalAction: pipelineResult.finalAction,
        estimatedCost: pipelineResult.context.agentResult?.estimatedCost,
      });

      // Update PRD reference (pipeline may have modified it)
      prd = pipelineResult.context.prd;

      // Handle pipeline result
      const handlerCtx = {
        config: ctx.config,
        prd,
        prdPath: ctx.prdPath,
        workdir: ctx.workdir,
        featureDir: ctx.featureDir,
        hooks: ctx.hooks,
        feature: ctx.feature,
        totalCost,
        startTime: ctx.startTime,
        runId: ctx.runId,
        pluginRegistry: ctx.pluginRegistry,
        story,
        storiesToExecute,
        routing: pipelineResult.context.routing ?? routing, // P4-001: use pipeline routing stage result
        isBatchExecution,
        allStoryMetrics,
        storyGitRef,
        interactionChain: ctx.interactionChain,
      };

      if (pipelineResult.success) {
        const successResult = await handlePipelineSuccess(handlerCtx, pipelineResult);
        totalCost += successResult.costDelta;
        storiesCompleted += successResult.storiesCompletedDelta;
        prd = successResult.prd;
        prdDirty = successResult.prdDirty;
      } else {
        const failResult = await handlePipelineFailure(handlerCtx, pipelineResult);
        prd = failResult.prd;
        prdDirty = failResult.prdDirty;
      }

      // Update status after story complete
      if (prdDirty) {
        prd = await loadPRD(ctx.prdPath);
        prdDirty = false;
      }
      ctx.statusWriter.setPrd(prd);
      ctx.statusWriter.setCurrentStory(null);
      await ctx.statusWriter.update(totalCost, iterations);

      // Stall detection
      if (isStalled(prd)) {
        const summary = generateHumanHaltSummary(prd);
        logger?.error("execution", "Execution stalled", {
          reason: "All remaining stories blocked or dependent on blocked stories",
          summary,
        });
        pipelineEventBus.emit({
          type: "run:paused",
          reason: "All remaining stories blocked or dependent on blocked stories",
          cost: totalCost,
        });
        return buildResult("stalled");
      }

      // Delay between iterations
      if (ctx.config.execution.iterationDelayMs > 0) {
        await Bun.sleep(ctx.config.execution.iterationDelayMs);
      }
    }

    return buildResult("max-iterations");
  } finally {
    // Stop heartbeat and write exit summary
    stopHeartbeat();
    await writeExitSummary(ctx.logFilePath, totalCost, iterations, storiesCompleted, Date.now() - ctx.startTime);
  }
}
