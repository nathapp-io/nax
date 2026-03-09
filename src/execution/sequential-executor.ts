/** Sequential Story Executor (ADR-005, Phase 4) — main execution loop. */

import { checkCostExceeded, checkCostWarning, checkPreMerge, isTriggerEnabled } from "../interaction/triggers";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { pipelineEventBus } from "../pipeline/event-bus";
import { runPipeline } from "../pipeline/runner";
import { postRunPipeline } from "../pipeline/stages";
import { wireEventsWriter } from "../pipeline/subscribers/events-writer";
import { wireHooks } from "../pipeline/subscribers/hooks";
import { wireInteraction } from "../pipeline/subscribers/interaction";
import { wireRegistry } from "../pipeline/subscribers/registry";
import { wireReporters } from "../pipeline/subscribers/reporters";
import type { PipelineContext } from "../pipeline/types";
import { generateHumanHaltSummary, isComplete, isStalled, loadPRD } from "../prd";
import type { PRD } from "../prd/types";
import { startHeartbeat } from "./crash-recovery";
import type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";
import { runIteration } from "./iteration-runner";
import { selectNextStories } from "./story-selector";

export type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";

export async function executeSequential(
  ctx: SequentialExecutionContext,
  initialPrd: PRD,
): Promise<SequentialExecutionResult> {
  const logger = getSafeLogger();
  let [prd, prdDirty, iterations, storiesCompleted, totalCost, lastStoryId, currentBatchIndex] = [
    initialPrd,
    false,
    0,
    0,
    0,
    null as string | null,
    0,
  ];
  const allStoryMetrics: StoryMetrics[] = [];
  let warningSent = false;

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
  });

  startHeartbeat(
    ctx.statusWriter,
    () => totalCost,
    () => iterations,
    ctx.logFilePath,
  );

  try {
    while (iterations < ctx.config.execution.maxIterations) {
      iterations++;
      if (Math.round(process.memoryUsage().heapUsed / 1024 / 1024) > 1024)
        logger?.warn("execution", "High memory usage detected");
      if (prdDirty) {
        prd = await loadPRD(ctx.prdPath);
        prdDirty = false;
      }
      if (isComplete(prd)) {
        // pre-merge trigger: prompt before completing the run
        if (ctx.interactionChain && isTriggerEnabled("pre-merge", ctx.config)) {
          const shouldProceed = await checkPreMerge(
            { featureName: ctx.feature, totalStories: prd.userStories.length, cost: totalCost },
            ctx.config,
            ctx.interactionChain,
          );
          if (!shouldProceed) {
            return buildResult("pre-merge-aborted");
          }
        }
        return buildResult("completed");
      }

      const selected = selectNextStories(prd, ctx.config, ctx.batchPlan, currentBatchIndex, lastStoryId, ctx.useBatch);
      if (!selected) return buildResult("no-stories");
      if (!selected.selection) {
        currentBatchIndex = selected.nextBatchIndex;
        continue;
      }
      currentBatchIndex = selected.nextBatchIndex;
      const { selection } = selected;
      if (!ctx.useBatch) lastStoryId = selection.story.id;

      if (totalCost >= ctx.config.execution.costLimit) {
        const shouldProceed =
          ctx.interactionChain && isTriggerEnabled("cost-exceeded", ctx.config)
            ? await checkCostExceeded(
                { featureName: ctx.feature, cost: totalCost, limit: ctx.config.execution.costLimit },
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

      const iter = await runIteration(ctx, prd, selection, iterations, totalCost, allStoryMetrics);
      [prd, storiesCompleted, totalCost, prdDirty] = [
        iter.prd,
        storiesCompleted + iter.storiesCompletedDelta,
        totalCost + iter.costDelta,
        iter.prdDirty,
      ];

      if (ctx.interactionChain && isTriggerEnabled("cost-warning", ctx.config) && !warningSent) {
        const costLimit = ctx.config.execution.costLimit;
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

    // Post-run pipeline (acceptance tests)
    logger?.info("execution", "Running post-run pipeline (acceptance tests)");
    await runPipeline(
      postRunPipeline,
      { config: ctx.config, prd, workdir: ctx.workdir, story: prd.userStories[0] } as unknown as PipelineContext,
      ctx.eventEmitter,
    );

    return buildResult("max-iterations");
  } finally {
    // Cleanup moved to runner.ts (RL-007): exit summary and heartbeat stop are owned by runner
  }
}
