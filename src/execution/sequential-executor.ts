/** Sequential Story Executor (ADR-005, Phase 4) — main execution loop. */

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
import { generateHumanHaltSummary, isComplete, isStalled, loadPRD } from "../prd";
import type { PRD } from "../prd/types";
import { startHeartbeat } from "./crash-recovery";
import { captureRunStartRef, runDeferredReview } from "./deferred-review";
import type { DeferredReviewResult } from "./deferred-review";
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
  let deferredReview: DeferredReviewResult | undefined;

  const runStartRef = await captureRunStartRef(ctx.workdir);

  pipelineEventBus.clear();
  wireHooks(pipelineEventBus, ctx.hooks, ctx.workdir, ctx.feature);
  wireReporters(pipelineEventBus, ctx.pluginRegistry, ctx.runId, ctx.startTime);
  wireInteraction(pipelineEventBus, ctx.interactionChain, ctx.config);
  wireEventsWriter(pipelineEventBus, ctx.feature, ctx.runId, ctx.workdir);
  wireRegistry(pipelineEventBus, ctx.feature, ctx.runId, ctx.workdir);

  // Emit run:started once — subscribers (hooks.ts, reporters.ts) own the fan-out.
  // Direct fireHook("on-start") and reporter.onRunStart() calls have been removed.
  pipelineEventBus.emit({
    type: "run:started",
    feature: ctx.feature,
    totalStories: initialPrd.userStories.length,
    workdir: ctx.workdir,
  });

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
    // Early exit: skip pre-run pipeline when all stories are already complete.
    // Avoids unnecessary acceptance test regeneration (LLM cost) on re-runs
    // where everything already passed.
    if (isComplete(prd)) {
      logger?.info("execution", "All stories already complete — skipping pre-run pipeline");
      deferredReview = await runDeferredReview(ctx.workdir, ctx.config.review, ctx.pluginRegistry, runStartRef);
      return buildResult("completed");
    }

    // Pre-run pipeline (acceptance test setup with RED gate)
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
        deferredReview = await runDeferredReview(ctx.workdir, ctx.config.review, ctx.pluginRegistry, runStartRef);
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
        story: { id: selection.story.id, title: selection.story.title, status: selection.story.status, attempts: selection.story.attempts },
        workdir: ctx.workdir,
        modelTier: selection.routing.modelTier,
        agent: ctx.config.autoMode.defaultAgent,
        iteration: iterations,
      });

      const iter = await runIteration(ctx, prd, selection, iterations, totalCost, allStoryMetrics);
      await pipelineEventBus.drain();
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
      {
        config: ctx.config,
        prd,
        workdir: ctx.workdir,
        featureDir: ctx.featureDir,
        story: prd.userStories[0],
        acceptanceTestPaths: preRunCtx.acceptanceTestPaths,
      } as unknown as PipelineContext,
      ctx.eventEmitter,
    );

    return buildResult("max-iterations");
  } finally {
    // Cleanup moved to runner.ts (RL-007): exit summary and heartbeat stop are owned by runner
  }
}
