/** Unified Story Executor (ADR-005, Phase 4) — sequential loop with optional parallel dispatch. */

import { checkCostExceeded, checkCostWarning, checkPreMerge, isTriggerEnabled } from "../interaction/triggers";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { pipelineEventBus } from "../pipeline/event-bus";
import { runPipeline } from "../pipeline/runner";
import { postRunPipeline, preRunPipeline } from "../pipeline/stages";
import { wireEventsWriter } from "../pipeline/subscribers/events-writer";
import { wireHooks } from "../pipeline/subscribers/hooks";
import { wireInteraction } from "../pipeline/subscribers/interaction";
import { wireRegistry } from "../pipeline/subscribers/registry";
import { wireReporters } from "../pipeline/subscribers/reporters";
import type { PipelineContext } from "../pipeline/types";
import { isComplete, isStalled, loadPRD } from "../prd";
import type { PRD } from "../prd/types";
import { startHeartbeat, stopHeartbeat } from "./crash-recovery";
import { captureRunStartRef, runDeferredReview } from "./deferred-review";
import type { DeferredReviewResult } from "./deferred-review";
import type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";
import { buildPreviewRouting } from "./executor-types";
import { getAllReadyStories } from "./helpers";
import { runIteration } from "./iteration-runner";
import type { RunParallelBatchOptions, RunParallelBatchResult } from "./parallel-batch";
import { handlePipelineFailure } from "./pipeline-result-handler";
import { selectIndependentBatch, selectNextStories } from "./story-selector";

export type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";

export async function executeUnified(
  ctx: SequentialExecutionContext,
  initialPrd: PRD,
): Promise<SequentialExecutionResult> {
  const logger = getSafeLogger();
  let prd = initialPrd;
  let prdDirty = false;
  let iterations = 0;
  let storiesCompleted = 0;
  let totalCost = 0;
  let lastStoryId: string | null = null;
  let currentBatchIndex = 0;
  const allStoryMetrics: StoryMetrics[] = [];
  let warningSent = false;
  let deferredReview: DeferredReviewResult | undefined;

  const runStartRef = await captureRunStartRef(ctx.workdir);

  pipelineEventBus.clear();
  wireHooks(pipelineEventBus, ctx.hooks, ctx.workdir, ctx.feature);
  wireReporters(pipelineEventBus, ctx.pluginRegistry, ctx.runId, ctx.startTime);
  wireInteraction(pipelineEventBus, ctx.interactionChain, ctx.config);
  wireEventsWriter(pipelineEventBus, ctx.feature, ctx.runId, ctx.workdir);
  wireRegistry(pipelineEventBus, ctx.feature, ctx.runId, ctx.workdir);

  const buildResult = (exitReason: SequentialExecutionResult["exitReason"]): SequentialExecutionResult => ({
    prd,
    iterations,
    storiesCompleted,
    totalCost,
    allStoryMetrics,
    exitReason,
    deferredReview,
  });

  startHeartbeat(
    ctx.statusWriter,
    () => totalCost,
    () => iterations,
    ctx.logFilePath,
  );

  try {
    if (isComplete(prd)) {
      logger?.info("execution", "All stories already complete — skipping pre-run pipeline");
      deferredReview = await runDeferredReview(ctx.workdir, ctx.config.review, ctx.pluginRegistry, runStartRef);
      return buildResult("completed");
    }

    // Pre-run pipeline (acceptance test setup with RED gate) — only when acceptance is configured
    if (ctx.config.acceptance?.enabled) {
      logger?.info("execution", "Running pre-run pipeline (acceptance test setup)");
      const preRunCtx: PipelineContext = {
        config: ctx.config,
        effectiveConfig: ctx.config,
        prd,
        workdir: ctx.workdir,
        featureDir: ctx.featureDir,
        story: prd.userStories[0],
        stories: prd.userStories,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
        hooks: ctx.hooks,
        agentGetFn: ctx.agentGetFn,
      };
      await runPipeline(preRunPipeline, preRunCtx, ctx.eventEmitter);
    }

    while (iterations < ctx.config.execution.maxIterations) {
      iterations++;
      if (Math.round(process.memoryUsage().heapUsed / 1024 / 1024) > 1024)
        logger?.warn("execution", "High memory usage detected");
      if (prdDirty) {
        prd = await loadPRD(ctx.prdPath);
        prdDirty = false;
      }
      if (isComplete(prd)) {
        if (ctx.interactionChain && isTriggerEnabled("pre-merge", ctx.config)) {
          const shouldProceed = await checkPreMerge(
            { featureName: ctx.feature, totalStories: prd.userStories.length, cost: totalCost },
            ctx.config,
            ctx.interactionChain,
          );
          if (!shouldProceed) return buildResult("pre-merge-aborted");
        }
        deferredReview = await runDeferredReview(ctx.workdir, ctx.config.review, ctx.pluginRegistry, runStartRef);
        return buildResult("completed");
      }

      const costLimit = ctx.config.execution.costLimit;

      // Parallel dispatch: when parallelCount > 0 and batch has more than 1 story
      if ((ctx.parallelCount ?? 0) > 0) {
        const readyStories = getAllReadyStories(prd);
        const batch = _unifiedExecutorDeps.selectIndependentBatch(readyStories, ctx.parallelCount as number);

        if (batch.length > 1) {
          // Emit story:started for each batch story before dispatch (AC-5)
          for (const story of batch) {
            pipelineEventBus.emit({
              type: "story:started",
              storyId: story.id,
              story,
              workdir: ctx.workdir,
              modelTier:
                story.routing?.modelTier ??
                ctx.config.autoMode.complexityRouting?.[story.routing?.complexity ?? "medium"] ??
                "balanced",
              agent: ctx.config.autoMode.defaultAgent,
              iteration: iterations,
            });
          }

          const batchStartedAt = new Date().toISOString();
          const storyStartMs = new Map<string, number>();
          for (const s of batch) storyStartMs.set(s.id, Date.now());

          const batchResult = await _unifiedExecutorDeps.runParallelBatch({
            stories: batch,
            ctx: {
              workdir: ctx.workdir,
              config: ctx.config,
              hooks: ctx.hooks,
              pluginRegistry: ctx.pluginRegistry,
              maxConcurrency: ctx.parallelCount as number,
              pipelineContext: {
                config: ctx.config,
                effectiveConfig: ctx.config,
                prd,
                hooks: ctx.hooks,
                featureDir: ctx.featureDir,
                agentGetFn: ctx.agentGetFn,
                pidRegistry: ctx.pidRegistry,
              },
              eventEmitter: ctx.eventEmitter,
              agentGetFn: ctx.agentGetFn,
            },
            prd,
          });

          // Route parallel failures through handlePipelineFailure (AC-6)
          for (const { story, pipelineResult } of batchResult.failed) {
            const storyRouting = prd.userStories.find((s) => s.id === story.id)?.routing;
            await handlePipelineFailure(
              {
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
                storiesToExecute: [story],
                routing: {
                  complexity: storyRouting?.complexity ?? "medium",
                  modelTier: storyRouting?.modelTier ?? "balanced",
                  testStrategy: storyRouting?.testStrategy ?? "test-after",
                  reasoning: storyRouting?.reasoning ?? "",
                },
                isBatchExecution: false,
                allStoryMetrics,
                storyGitRef: null,
                interactionChain: ctx.interactionChain,
              },
              pipelineResult,
            );
          }

          totalCost += batchResult.totalCost;
          storiesCompleted += batchResult.completed.length;
          prdDirty = true;

          // Build per-story metrics for completed parallel batch stories
          const batchCompletedAt = new Date().toISOString();
          for (const story of batchResult.completed) {
            const storyCost = batchResult.storyCosts.get(story.id) ?? 0;
            const storyStartTime = storyStartMs.get(story.id) ?? Date.now();
            allStoryMetrics.push({
              storyId: story.id,
              complexity: story.routing?.complexity ?? "medium",
              modelTier: story.routing?.modelTier ?? "balanced",
              modelUsed: ctx.config.autoMode.defaultAgent,
              attempts: 1,
              finalTier: story.routing?.modelTier ?? "balanced",
              success: true,
              cost: storyCost,
              durationMs: Date.now() - storyStartTime,
              firstPassSuccess: true,
              startedAt: batchStartedAt,
              completedAt: batchCompletedAt,
              source: "parallel" as const,
            });
          }

          // Cost-limit check after parallel batch (AC-7)
          if (totalCost >= costLimit) {
            return buildResult("cost-limit");
          }

          continue;
        }

        // batch.length === 1: dispatch the single story the batch selector chose,
        // honouring its dependency/priority logic rather than re-running selectNextStories.
        if (batch.length === 1) {
          const singleStory = batch[0];
          const singleSelection = {
            story: singleStory,
            storiesToExecute: [singleStory],
            routing: buildPreviewRouting(singleStory, ctx.config),
            isBatchExecution: false,
          };

          if (!ctx.useBatch) lastStoryId = singleStory.id;

          if (totalCost >= costLimit) {
            const shouldProceed =
              ctx.interactionChain && isTriggerEnabled("cost-exceeded", ctx.config)
                ? await checkCostExceeded(
                    { featureName: ctx.feature, cost: totalCost, limit: costLimit },
                    ctx.config,
                    ctx.interactionChain,
                  )
                : false;
            if (!shouldProceed) {
              pipelineEventBus.emit({
                type: "run:paused",
                reason: `Cost limit reached: $${totalCost.toFixed(2)}`,
                storyId: singleStory.id,
                cost: totalCost,
              });
              return buildResult("cost-limit");
            }
            pipelineEventBus.emit({ type: "run:resumed", feature: ctx.feature });
          }

          pipelineEventBus.emit({
            type: "story:started",
            storyId: singleStory.id,
            story: singleStory,
            workdir: ctx.workdir,
            modelTier: singleSelection.routing.modelTier,
            agent: ctx.config.autoMode.defaultAgent,
            iteration: iterations,
          });

          const singleIter = await _unifiedExecutorDeps.runIteration(
            ctx,
            prd,
            singleSelection,
            iterations,
            totalCost,
            allStoryMetrics,
          );
          [prd, storiesCompleted, totalCost, prdDirty] = [
            singleIter.prd,
            storiesCompleted + singleIter.storiesCompletedDelta,
            totalCost + singleIter.costDelta,
            singleIter.prdDirty,
          ];

          if (singleIter.finalAction === "decomposed") {
            iterations--;
            pipelineEventBus.emit({
              type: "story:decomposed",
              storyId: singleStory.id,
              story: singleStory,
              subStoryCount: singleIter.subStoryCount ?? 0,
            });
            if (singleIter.prdDirty) {
              prd = await loadPRD(ctx.prdPath);
              prdDirty = false;
            }
            ctx.statusWriter.setPrd(prd);
            continue;
          }

          if (singleIter.prdDirty) {
            prd = await loadPRD(ctx.prdPath);
            prdDirty = false;
          }
          ctx.statusWriter.setPrd(prd);
          ctx.statusWriter.setCurrentStory(null);
          await ctx.statusWriter.update(totalCost, iterations);

          if (isStalled(prd)) {
            pipelineEventBus.emit({ type: "run:paused", reason: "All remaining stories blocked", cost: totalCost });
            return buildResult("stalled");
          }
          if (ctx.config.execution.iterationDelayMs > 0) await Bun.sleep(ctx.config.execution.iterationDelayMs);
          continue;
        }
        // batch.length === 0: fall through to sequential single-story path
      }

      // Sequential single-story dispatch
      const selected = selectNextStories(prd, ctx.config, ctx.batchPlan, currentBatchIndex, lastStoryId, ctx.useBatch);
      if (!selected) return buildResult("no-stories");
      if (!selected.selection) {
        currentBatchIndex = selected.nextBatchIndex;
        continue;
      }
      currentBatchIndex = selected.nextBatchIndex;
      const { selection } = selected;
      if (!ctx.useBatch) lastStoryId = selection.story.id;

      if (totalCost >= costLimit) {
        const shouldProceed =
          ctx.interactionChain && isTriggerEnabled("cost-exceeded", ctx.config)
            ? await checkCostExceeded(
                { featureName: ctx.feature, cost: totalCost, limit: costLimit },
                ctx.config,
                ctx.interactionChain,
              )
            : false;
        if (!shouldProceed) {
          pipelineEventBus.emit({
            type: "run:paused",
            reason: `Cost limit reached: $${totalCost.toFixed(2)}`,
            storyId: selection.story.id,
            cost: totalCost,
          });
          return buildResult("cost-limit");
        }
        pipelineEventBus.emit({ type: "run:resumed", feature: ctx.feature });
      }

      pipelineEventBus.emit({
        type: "story:started",
        storyId: selection.story.id,
        story: selection.story,
        workdir: ctx.workdir,
        modelTier: selection.routing.modelTier,
        agent: ctx.config.autoMode.defaultAgent,
        iteration: iterations,
      });

      const iter = await _unifiedExecutorDeps.runIteration(ctx, prd, selection, iterations, totalCost, allStoryMetrics);
      [prd, storiesCompleted, totalCost, prdDirty] = [
        iter.prd,
        storiesCompleted + iter.storiesCompletedDelta,
        totalCost + iter.costDelta,
        iter.prdDirty,
      ];

      // ENH-009: Decomposition is not real work — don't charge an iteration.
      if (iter.finalAction === "decomposed") {
        iterations--;
        pipelineEventBus.emit({
          type: "story:decomposed",
          storyId: selection.story.id,
          story: selection.story,
          subStoryCount: iter.subStoryCount ?? 0,
        });
        if (iter.prdDirty) {
          prd = await loadPRD(ctx.prdPath);
          prdDirty = false;
        }
        ctx.statusWriter.setPrd(prd);
        continue;
      }

      if (ctx.interactionChain && isTriggerEnabled("cost-warning", ctx.config) && !warningSent) {
        const triggerCfg = ctx.config.interaction?.triggers?.["cost-warning"];
        const threshold = typeof triggerCfg === "object" ? (triggerCfg.threshold ?? 0.8) : 0.8;
        if (totalCost >= costLimit * threshold) {
          await checkCostWarning(
            { featureName: ctx.feature, cost: totalCost, limit: costLimit },
            ctx.config,
            ctx.interactionChain,
          );
          warningSent = true;
        }
      }

      if (iter.prdDirty) {
        prd = await loadPRD(ctx.prdPath);
        prdDirty = false;
      }
      ctx.statusWriter.setPrd(prd);
      ctx.statusWriter.setCurrentStory(null);
      await ctx.statusWriter.update(totalCost, iterations);

      if (isStalled(prd)) {
        pipelineEventBus.emit({ type: "run:paused", reason: "All remaining stories blocked", cost: totalCost });
        return buildResult("stalled");
      }
      if (ctx.config.execution.iterationDelayMs > 0) await Bun.sleep(ctx.config.execution.iterationDelayMs);
    }

    // Post-run pipeline (acceptance tests) — only when acceptance is configured
    if (ctx.config.acceptance?.enabled) {
      logger?.info("execution", "Running post-run pipeline (acceptance tests)");
      await runPipeline(
        postRunPipeline,
        { config: ctx.config, prd, workdir: ctx.workdir, story: prd.userStories[0] } as unknown as PipelineContext,
        ctx.eventEmitter,
      );
    }

    return buildResult("max-iterations");
  } finally {
    stopHeartbeat();
  }
}

/**
 * Injectable dependencies for testing.
 * Defined after executeUnified so "story:started" precedes "runParallelBatch" in source order.
 * @internal — test use only.
 */
export const _unifiedExecutorDeps = {
  runParallelBatch: async (opts: RunParallelBatchOptions): Promise<RunParallelBatchResult> => {
    const { runParallelBatch } = await import("./parallel-batch");
    return runParallelBatch(opts);
  },
  runIteration,
  selectIndependentBatch,
};
