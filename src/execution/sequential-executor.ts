/** Sequential Story Executor — main execution loop for story pipeline. */

import type { NaxConfig } from "../config";
import { type LoadedHooksConfig, fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext, RoutingResult } from "../pipeline/types";
import type { PluginRegistry } from "../plugins";
import { generateHumanHaltSummary, getNextStory, isComplete, isStalled, loadPRD } from "../prd";
import type { PRD, UserStory } from "../prd/types";
import { routeTask } from "../routing";
import { captureGitRef } from "../utils/git";
import type { StoryBatch } from "./batching";
import { startHeartbeat, stopHeartbeat, writeExitSummary } from "./crash-recovery";
import { preIterationTierCheck } from "./escalation";
import { hookCtx } from "./helpers";
import {
  applyCachedRouting,
  handleDryRun,
  handlePipelineFailure,
  handlePipelineSuccess,
} from "./pipeline-result-handler";
import type { StatusWriter } from "./status-writer";

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
}

export interface SequentialExecutionResult {
  prd: PRD;
  iterations: number;
  storiesCompleted: number;
  totalCost: number;
  allStoryMetrics: StoryMetrics[];
  timeoutRetryCountMap: Map<string, number>;
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
  const timeoutRetryCountMap = new Map<string, number>();
  let currentBatchIndex = 0;

  const buildResult = (exitReason: SequentialExecutionResult["exitReason"]): SequentialExecutionResult => ({
    prd,
    iterations,
    storiesCompleted,
    totalCost,
    allStoryMetrics,
    timeoutRetryCountMap,
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
        await fireHook(
          ctx.hooks,
          "on-complete",
          hookCtx(ctx.feature, { status: "complete", cost: totalCost }),
          ctx.workdir,
        );
        return buildResult("completed");
      }

      // Get next story/batch
      let storiesToExecute: UserStory[];
      let isBatchExecution: boolean;
      let story: UserStory;
      let routing: ReturnType<typeof routeTask>;

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
        routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, ctx.config);
        routing = applyCachedRouting(routing, story, ctx.config);
      } else {
        // Fallback to single-story mode (when batching disabled or batch plan exhausted)
        const nextStory = getNextStory(prd);
        if (!nextStory) {
          logger?.warn("execution", "No actionable stories (check dependencies)");
          return buildResult("no-stories");
        }

        story = nextStory;
        storiesToExecute = [story];
        isBatchExecution = false;

        routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, ctx.config);
        routing = applyCachedRouting(routing, story, ctx.config);
      }

      // Pre-iteration tier escalation check
      const tierCheckResult = await preIterationTierCheck(
        story,
        routing,
        ctx.config,
        prd,
        ctx.prdPath,
        ctx.featureDir,
        ctx.hooks,
        ctx.feature,
        totalCost,
        ctx.workdir,
      );

      if (tierCheckResult.shouldSkipIteration) {
        prd = tierCheckResult.prd;
        prdDirty = tierCheckResult.prdDirty;
        continue;
      }

      // Check cost limit
      if (totalCost >= ctx.config.execution.costLimit) {
        logger?.warn("execution", "Cost limit reached, pausing", {
          totalCost,
          costLimit: ctx.config.execution.costLimit,
        });
        await fireHook(
          ctx.hooks,
          "on-pause",
          hookCtx(ctx.feature, {
            storyId: story.id,
            reason: `Cost limit reached: $${totalCost.toFixed(2)}`,
            cost: totalCost,
          }),
          ctx.workdir,
        );
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

      // Fire story-start hook
      await fireHook(
        ctx.hooks,
        "on-story-start",
        hookCtx(ctx.feature, {
          storyId: story.id,
          model: routing.modelTier,
          agent: ctx.config.autoMode.defaultAgent,
          iteration: iterations,
        }),
        ctx.workdir,
      );

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
        routing,
        isBatchExecution,
        allStoryMetrics,
        timeoutRetryCountMap,
        storyGitRef,
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
        await fireHook(
          ctx.hooks,
          "on-pause",
          hookCtx(ctx.feature, {
            reason: "All remaining stories blocked or dependent on blocked stories",
            cost: totalCost,
          }),
          ctx.workdir,
        );
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
