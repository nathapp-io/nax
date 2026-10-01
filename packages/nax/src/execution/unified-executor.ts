/** Unified Story Executor (ADR-005, Phase 4) — sequential loop with optional parallel dispatch. */

import { pipelineEventBus } from "@/pipeline/event-bus";
import { checkPreMerge, isTriggerEnabled } from "../interaction/triggers";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
import { logPipelineOutcome, runPipeline } from "../pipeline/runner";
import { wireEventsWriter } from "../pipeline/subscribers/events-writer";
import { wireHooks } from "../pipeline/subscribers/hooks";
import { wireInteraction } from "../pipeline/subscribers/interaction";
import { wireRegistry } from "../pipeline/subscribers/registry";
import { wireReporters } from "../pipeline/subscribers/reporters";
import type { PipelineContext } from "../pipeline/types";
import { countStories, isComplete, loadPRD } from "../prd";
import type { PRD } from "../prd/types";
import { totalSpendUsd } from "../runtime";
import { buildNaxIgnoreIndex } from "../utils/path-filters";
import { storyPackageDir } from "../utils/path-frame";
import { startHeartbeat } from "./crash-recovery";
import { captureRunStartRef, type DeferredReviewResult, runDeferredReview } from "./deferred-review";
import { preIterationTierCheck } from "./escalation";
import type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";
import { runIteration } from "./iteration-runner";
import type { RunParallelBatchOptions, RunParallelBatchResult } from "./parallel-batch";
import { runPreRunPipeline } from "./pre-run";
import { selectIndependentBatch } from "./story-selector";
import type { LoopState } from "./unified-executor-dispatch-phases";
import { runSequentialDispatch } from "./unified-executor-dispatch-phases";
import { runParallelDispatch } from "./unified-executor-parallel-dispatch";

export type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";

// Internal run-scoped unsubscribers; do not clear the bus because it has external subscribers.
let _prevRunUnsubscribers: Array<() => void> = [];

export async function executeUnified(
  ctx: SequentialExecutionContext,
  initialPrd: PRD,
): Promise<SequentialExecutionResult> {
  const logger = getSafeLogger();
  let iterations = 0;
  const allStoryMetrics: StoryMetrics[] = [];
  let deferredReview: DeferredReviewResult | undefined;
  let deferredReviewStartedAt: number | undefined;
  let state: LoopState = {
    prd: initialPrd,
    prdDirty: false,
    totalCost: 0,
    storiesCompleted: 0,
    lastStoryId: null, // feeds retry-priority (BUG-39)
    warningSent: false,
  };
  // The heartbeat reads this, not state.totalCost: `state` is only replaced when a
  // dispatch phase returns, which is after its statusWriter.update and iteration delay.
  // It also takes the aggregator's running total, so a tick mid-story, during the
  // post-run pipeline, or after executeUnified returns never reports less than was spent.
  let liveCost = state.totalCost;
  const heartbeatCost = () => Math.max(liveCost, totalSpendUsd(ctx.runtime.costAggregator.snapshot()));

  const runStartRef = await captureRunStartRef(ctx.workdir);
  let cachedNaxIgnoreKey: string | undefined;
  const getRunNaxIgnoreIndex = async (currentPrd: PRD) => {
    const packageDirs = [
      ...new Set(
        currentPrd.userStories
          .map((s) => storyPackageDir(s))
          .filter((w): w is string => w !== undefined)
          .map((w) => `${ctx.workdir}/${w}`),
      ),
    ].sort();
    const cacheKey = packageDirs.join("|");
    if (ctx.naxIgnoreIndex && cachedNaxIgnoreKey === cacheKey) return ctx.naxIgnoreIndex;
    const nextIndex = await buildNaxIgnoreIndex(ctx.workdir, packageDirs);
    cachedNaxIgnoreKey = cacheKey;
    ctx.naxIgnoreIndex = nextIndex;
    return nextIndex;
  };

  // Tear down previous run's subscribers; preserves external subscribers (e.g. TUI) across run boundaries.
  for (const fn of _prevRunUnsubscribers) fn();
  _prevRunUnsubscribers = [];
  const thisRunUnsubscribers = [
    wireHooks(pipelineEventBus, ctx.hooks, ctx.workdir, ctx.feature),
    wireReporters(pipelineEventBus, ctx.pluginRegistry, ctx.runId, ctx.startTime, ctx.runtime.projectKey),
    wireInteraction(pipelineEventBus, ctx.interactionChain, ctx.config),
    wireEventsWriter(pipelineEventBus, ctx.feature, ctx.runId, ctx.workdir),
    wireRegistry(pipelineEventBus, ctx.feature, ctx.runId, ctx.workdir, ctx.runtime.outputDir),
  ];
  _prevRunUnsubscribers = thisRunUnsubscribers;

  // Emit run:started once — subscribers own the fan-out.
  pipelineEventBus.emit({
    type: "run:started",
    feature: ctx.feature,
    totalStories: initialPrd.userStories.length,
    workdir: ctx.workdir,
  });

  const buildResult = (exitReason: SequentialExecutionResult["exitReason"]): SequentialExecutionResult => ({
    prd: state.prd,
    iterations,
    storiesCompleted: state.storiesCompleted,
    totalCost: state.totalCost,
    allStoryMetrics,
    exitReason,
    deferredReview,
    deferredReviewStartedAt,
  });

  startHeartbeat(ctx.statusWriter, heartbeatCost, () => iterations, ctx.logFilePath);

  const runCompletionDeferredReview = async (naxIgnoreIndex: Awaited<ReturnType<typeof getRunNaxIgnoreIndex>>) => {
    deferredReviewStartedAt = Date.now();
    pipelineEventBus.emit({ type: "postrun:phase:started", phase: "review" });
    deferredReview = await runDeferredReview(
      ctx.workdir,
      ctx.config.review,
      ctx.pluginRegistry,
      runStartRef,
      naxIgnoreIndex,
    );
  };

  let _executeThrew = false;
  try {
    if (isComplete(state.prd)) {
      logger?.info("execution", "All stories already complete — skipping pre-run pipeline");
      await runCompletionDeferredReview(await getRunNaxIgnoreIndex(state.prd));
      return buildResult("completed");
    }

    // Pre-run pipeline (acceptance test setup with RED gate). Skipped under dryRun (nax#1809).
    let preRunCtx: PipelineContext | undefined;
    if (!ctx.dryRun && ctx.config.acceptance?.enabled) {
      logger?.info("execution", "Running pre-run pipeline (acceptance test setup)");
      const { preRunPipeline } = await import("../pipeline/stages");
      preRunCtx = await runPreRunPipeline(
        {
          config: ctx.config,
          workdir: ctx.workdir,
          featureDir: ctx.featureDir,
          hooks: ctx.hooks,
          agentGetFn: ctx.agentGetFn,
          agentManager: ctx.agentManager,
          sessionManager: ctx.sessionManager,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          eventEmitter: ctx.eventEmitter,
        },
        state.prd,
        await getRunNaxIgnoreIndex(state.prd),
        preRunPipeline,
      );
    }

    while (iterations < ctx.config.execution.maxIterations) {
      iterations++;
      if (Math.round(process.memoryUsage().heapUsed / 1024 / 1024) > 1024)
        logger?.warn("execution", "High memory usage detected");
      if (state.prdDirty) {
        state = { ...state, prd: await loadPRD(ctx.prdPath), prdDirty: false };
      }
      const naxIgnoreIndex = await getRunNaxIgnoreIndex(state.prd);
      const storyCounts = countStories(state.prd);
      logger?.debug("execution", "Loop iteration", {
        iteration: iterations,
        isComplete: isComplete(state.prd),
        passed: storyCounts.passed,
        pending: storyCounts.pending,
        failed: storyCounts.failed,
        total: storyCounts.total,
      });
      if (isComplete(state.prd)) {
        logger?.debug("execution", "All stories complete — entering completion path");
        if (ctx.interactionChain && isTriggerEnabled("pre-merge", ctx.config)) {
          const shouldProceed = await checkPreMerge(
            { featureName: ctx.feature, totalStories: state.prd.userStories.length, cost: state.totalCost },
            ctx.config,
            ctx.interactionChain,
          );
          if (!shouldProceed) return buildResult("pre-merge-aborted");
        }
        logger?.debug("execution", "Running deferred review");
        await runCompletionDeferredReview(naxIgnoreIndex);
        logger?.debug("execution", "Deferred review done — returning completed");
        return buildResult("completed");
      }

      const costLimit = ctx.config.execution.costLimit;
      const reportCost = (cost: number) => {
        liveCost = cost;
      };
      const dispatchParams = { ctx, state, iterations, allStoryMetrics, naxIgnoreIndex, costLimit, reportCost };

      // Parallel dispatch when parallelCount > 0 and batch > 1 story. Never under a dry run: runIteration owns that short-circuit (nax#1808).
      if ((ctx.parallelCount ?? 0) > 0 && !ctx.dryRun) {
        const step = await runParallelDispatch(dispatchParams, {
          selectIndependentBatch: _unifiedExecutorDeps.selectIndependentBatch,
          preIterationTierCheck: _unifiedExecutorDeps.preIterationTierCheck,
          runParallelBatch: _unifiedExecutorDeps.runParallelBatch,
          runIteration: _unifiedExecutorDeps.runIteration,
        });
        if (step.action !== "fallthrough") {
          state = step.state;
          if (step.action === "return") return buildResult(step.exitReason);
          continue;
        }
        // batch.length === 0: fall through to sequential single-story path
        state = step.state;
      }

      const seqStep = await runSequentialDispatch(dispatchParams, {
        runIteration: _unifiedExecutorDeps.runIteration,
        preIterationTierCheck: _unifiedExecutorDeps.preIterationTierCheck,
      });
      state = seqStep.state;
      if (seqStep.action === "return") return buildResult(seqStep.exitReason);
    }

    // Post-run pipeline (acceptance tests) — only when acceptance is configured
    if (ctx.config.acceptance?.enabled) {
      logger?.info("execution", "Running post-run pipeline (acceptance tests)");
      const { postRunPipeline } = await import("../pipeline/stages");
      const postRunResult = await runPipeline(
        postRunPipeline,
        {
          config: ctx.config,
          rootConfig: ctx.config,
          prd: state.prd,
          workdir: ctx.workdir,
          projectDir: ctx.workdir,
          featureDir: ctx.featureDir,
          story: state.prd.userStories[0],
          stories: state.prd.userStories,
          routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
          hooks: ctx.hooks,
          agentGetFn: ctx.agentGetFn,
          agentManager: ctx.agentManager,
          sessionManager: ctx.sessionManager,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          acceptanceTestPaths: preRunCtx?.acceptanceTestPaths,
        } satisfies PipelineContext,
        ctx.eventEmitter,
      );
      logPipelineOutcome(postRunResult, "Post-run pipeline (acceptance tests)");
    }

    return buildResult("max-iterations");
  } catch (err) {
    _executeThrew = true;
    throw err;
  } finally {
    // NOTE: stopHeartbeat() is intentionally NOT called here.
    // The heartbeat must stay alive until runner-completion.ts finishes the
    // regression gate and exit summary — those run AFTER executeUnified returns.
    // stopHeartbeat() is called by runner.ts:finally (catches all exit paths)
    // and by runner-completion.ts after handleRunCompletion().

    // On throw only: tear down this run's subscribers immediately so they don't
    // accumulate on pipelineEventBus across failed runs. On normal return, leave
    // them active so runner.ts can emit run:ended with reporters still subscribed.
    // Guard: a subsequent execute() call may have already replaced _prevRunUnsubscribers.
    if (_executeThrew && _prevRunUnsubscribers === thisRunUnsubscribers) {
      for (const fn of thisRunUnsubscribers) fn();
      _prevRunUnsubscribers = [];
    }
  }
}
export { reconcileBatchOutcome } from "./reconcile-batch-outcome";

/**
 * Injectable dependencies for testing.
 * @internal — test use only.
 */
export const _unifiedExecutorDeps = {
  runParallelBatch: async (opts: RunParallelBatchOptions): Promise<RunParallelBatchResult> => {
    const { runParallelBatch } = await import("./parallel-batch");
    return runParallelBatch(opts);
  },
  runIteration,
  selectIndependentBatch,
  preIterationTierCheck,
};
