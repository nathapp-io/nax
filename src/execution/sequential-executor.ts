/**
 * Sequential Story Executor
 *
 * Executes stories sequentially (one at a time) through the pipeline.
 * Main execution loop that:
 * 1. Gets next story/batch from precomputed plan
 * 2. Runs story through pipeline
 * 3. Handles pipeline results (success/fail/pause/escalate)
 * 4. Updates PRD and progress
 * 5. Checks for completion/stall conditions
 */

import path from "node:path";
import { convertFixStoryToUserStory, generateFixStories } from "../acceptance";
import { getAgent } from "../agents";
import type { NaxConfig } from "../config";
import { type LoadedHooksConfig, fireHook } from "../hooks";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import type { PipelineEventEmitter } from "../pipeline/events";
import { runPipeline } from "../pipeline/runner";
import { defaultPipeline } from "../pipeline/stages";
import type { PipelineContext, RoutingResult } from "../pipeline/types";
import type { PluginRegistry } from "../plugins";
import {
  countStories,
  generateHumanHaltSummary,
  getNextStory,
  isComplete,
  isStalled,
  loadPRD,
  markStoryFailed,
  markStoryPaused,
  savePRD,
} from "../prd";
import type { PRD, UserStory } from "../prd/types";
import { routeTask } from "../routing";
import { captureGitRef } from "../utils/git";
import type { StoryBatch } from "./batching";
import { startHeartbeat, stopHeartbeat, writeExitSummary } from "./crash-recovery";
import { handleTierEscalation, preIterationTierCheck } from "./escalation";
import { getAllReadyStories, hookCtx } from "./helpers";
import { emitStoryComplete } from "./lifecycle/story-hooks";
import { runPostAgentVerification } from "./post-verify";
import { appendProgress } from "./progress";
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
 * Apply cached routing overrides from story.routing to a fresh routing decision.
 */
function applyCachedRouting(
  routing: ReturnType<typeof routeTask>,
  story: UserStory,
  config: NaxConfig,
): ReturnType<typeof routeTask> {
  if (!story.routing) return routing;
  const overrides: Partial<ReturnType<typeof routeTask>> = {};
  if (story.routing.complexity) {
    overrides.complexity = story.routing.complexity;
    const tierFromComplexity = config.autoMode.complexityRouting[story.routing.complexity] ?? "balanced";
    overrides.modelTier = tierFromComplexity as ReturnType<typeof routeTask>["modelTier"];
  }
  if (story.routing.testStrategy) {
    overrides.testStrategy = story.routing.testStrategy;
  }
  return { ...routing, ...overrides };
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

  // Start heartbeat
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
        return {
          prd,
          iterations,
          storiesCompleted,
          totalCost,
          allStoryMetrics,
          timeoutRetryCountMap,
          exitReason: "completed",
        };
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
          return {
            prd,
            iterations,
            storiesCompleted,
            totalCost,
            allStoryMetrics,
            timeoutRetryCountMap,
            exitReason: "no-stories",
          };
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
        return {
          prd,
          iterations,
          storiesCompleted,
          totalCost,
          allStoryMetrics,
          timeoutRetryCountMap,
          exitReason: "cost-limit",
        };
      }

      logger?.info("execution", `Starting iteration ${iterations}`, {
        iteration: iterations,
        isBatch: isBatchExecution,
        batchSize: isBatchExecution ? storiesToExecute.length : 1,
        storyId: story.id,
        storyTitle: story.title,
        ...(isBatchExecution && { batchStoryIds: storiesToExecute.map((s) => s.id) }),
      });

      // Log iteration start
      logger?.info("iteration.start", `Starting iteration ${iterations}`, {
        iteration: iterations,
        storyId: story.id,
        storyTitle: story.title,
        isBatch: isBatchExecution,
        batchSize: isBatchExecution ? storiesToExecute.length : 1,
        modelTier: routing.modelTier,
        complexity: routing.complexity,
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
        // Dry-run mode
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

        for (const s of storiesToExecute) {
          logger?.info("execution", "[DRY RUN] Would execute agent here", {
            storyId: s.id,
            storyTitle: s.title,
            modelTier: routing.modelTier,
            complexity: routing.complexity,
            testStrategy: routing.testStrategy,
          });
        }

        // Mark stories as passed so the loop progresses
        for (const s of storiesToExecute) {
          const { markStoryPassed } = await import("../prd");
          markStoryPassed(prd, s.id);
        }
        storiesCompleted += storiesToExecute.length;
        prdDirty = true;
        await savePRD(prd, ctx.prdPath);

        // Emit onStoryComplete events for dry-run
        const reporters = ctx.pluginRegistry.getReporters();
        for (const s of storiesToExecute) {
          await emitStoryComplete(reporters, {
            runId: ctx.runId,
            storyId: s.id,
            status: "completed",
            durationMs: 0,
            cost: 0,
            tier: routing.modelTier,
            testStrategy: routing.testStrategy,
          });
        }

        ctx.statusWriter.setPrd(prd);
        ctx.statusWriter.setCurrentStory(null);
        await ctx.statusWriter.update(totalCost, iterations);

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
      if (pipelineResult.success) {
        // Pipeline completed successfully
        totalCost += pipelineResult.context.agentResult?.estimatedCost || 0;
        prdDirty = true;

        // Collect story metrics
        if (pipelineResult.context.storyMetrics) {
          allStoryMetrics.push(...pipelineResult.context.storyMetrics);
        }

        // Post-agent verification
        const verifyResult = await runPostAgentVerification({
          config: ctx.config,
          prd,
          prdPath: ctx.prdPath,
          workdir: ctx.workdir,
          featureDir: ctx.featureDir,
          story,
          storiesToExecute,
          allStoryMetrics,
          timeoutRetryCountMap,
          storyGitRef,
        });
        const verificationPassed = verifyResult.passed;
        prd = verifyResult.prd;

        if (verificationPassed) {
          storiesCompleted += storiesToExecute.length;

          // Log story completion and emit reporter events
          const reporters = ctx.pluginRegistry.getReporters();
          for (const completedStory of storiesToExecute) {
            logger?.info("story.complete", "Story completed successfully", {
              storyId: completedStory.id,
              storyTitle: completedStory.title,
              totalCost,
              durationMs: Date.now() - ctx.startTime,
            });

            await emitStoryComplete(reporters, {
              runId: ctx.runId,
              storyId: completedStory.id,
              status: "completed",
              durationMs: Date.now() - ctx.startTime,
              cost: pipelineResult.context.agentResult?.estimatedCost || 0,
              tier: routing.modelTier,
              testStrategy: routing.testStrategy,
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
          totalCost,
          costLimit: ctx.config.execution.costLimit,
          elapsedMs,
        });
      } else {
        // Pipeline stopped early — handle based on finalAction
        const reporters = ctx.pluginRegistry.getReporters();

        switch (pipelineResult.finalAction) {
          case "pause":
            markStoryPaused(prd, story.id);
            await savePRD(prd, ctx.prdPath);
            prdDirty = true;

            logger?.warn("pipeline", "Story paused", {
              storyId: story.id,
              reason: pipelineResult.reason,
            });

            await fireHook(
              ctx.hooks,
              "on-pause",
              hookCtx(ctx.feature, {
                storyId: story.id,
                reason: pipelineResult.reason || "Pipeline paused",
                cost: totalCost,
              }),
              ctx.workdir,
            );

            await emitStoryComplete(reporters, {
              runId: ctx.runId,
              storyId: story.id,
              status: "paused",
              durationMs: Date.now() - ctx.startTime,
              cost: pipelineResult.context.agentResult?.estimatedCost || 0,
              tier: routing.modelTier,
              testStrategy: routing.testStrategy,
            });
            break;

          case "skip":
            logger?.warn("pipeline", "Story skipped", {
              storyId: story.id,
              reason: pipelineResult.reason,
            });
            prdDirty = true;

            await emitStoryComplete(reporters, {
              runId: ctx.runId,
              storyId: story.id,
              status: "skipped",
              durationMs: Date.now() - ctx.startTime,
              cost: 0,
              tier: routing.modelTier,
              testStrategy: routing.testStrategy,
            });
            break;

          case "fail":
            markStoryFailed(prd, story.id, pipelineResult.context.tddFailureCategory);
            await savePRD(prd, ctx.prdPath);
            prdDirty = true;

            logger?.error("pipeline", "Story failed", {
              storyId: story.id,
              reason: pipelineResult.reason,
            });

            if (ctx.featureDir) {
              await appendProgress(ctx.featureDir, story.id, "failed", `${story.title} — ${pipelineResult.reason}`);
            }

            await fireHook(
              ctx.hooks,
              "on-story-fail",
              hookCtx(ctx.feature, {
                storyId: story.id,
                status: "failed",
                reason: pipelineResult.reason || "Pipeline failed",
                cost: totalCost,
              }),
              ctx.workdir,
            );

            await emitStoryComplete(reporters, {
              runId: ctx.runId,
              storyId: story.id,
              status: "failed",
              durationMs: Date.now() - ctx.startTime,
              cost: pipelineResult.context.agentResult?.estimatedCost || 0,
              tier: routing.modelTier,
              testStrategy: routing.testStrategy,
            });
            break;

          case "escalate": {
            const escalationResult = await handleTierEscalation({
              story,
              storiesToExecute,
              isBatchExecution,
              routing,
              pipelineResult,
              config: ctx.config,
              prd,
              prdPath: ctx.prdPath,
              featureDir: ctx.featureDir,
              hooks: ctx.hooks,
              feature: ctx.feature,
              totalCost,
              workdir: ctx.workdir,
            });

            prd = escalationResult.prd;
            prdDirty = escalationResult.prdDirty;
            break;
          }
        }
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
        return {
          prd,
          iterations,
          storiesCompleted,
          totalCost,
          allStoryMetrics,
          timeoutRetryCountMap,
          exitReason: "stalled",
        };
      }

      // Delay between iterations
      if (ctx.config.execution.iterationDelayMs > 0) {
        await Bun.sleep(ctx.config.execution.iterationDelayMs);
      }
    }

    // Max iterations reached
    return {
      prd,
      iterations,
      storiesCompleted,
      totalCost,
      allStoryMetrics,
      timeoutRetryCountMap,
      exitReason: "max-iterations",
    };
  } finally {
    // Stop heartbeat and write exit summary
    stopHeartbeat();
    await writeExitSummary(ctx.logFilePath, totalCost, iterations, storiesCompleted, Date.now() - ctx.startTime);
  }
}
