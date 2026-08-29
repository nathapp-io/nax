/** Unified Story Executor (ADR-005, Phase 4) — sequential loop with optional parallel dispatch. */

import { pipelineEventBus } from "@/pipeline";
import { checkCostExceeded, checkPreMerge, isTriggerEnabled } from "../interaction/triggers";
import { getSafeLogger } from "../logger";
import { type StoryMetrics, toFallbackHops } from "../metrics";
import { runPipeline } from "../pipeline/runner";
import { postRunPipeline, preRunPipeline } from "../pipeline/stages";
import { wireEventsWriter } from "../pipeline/subscribers/events-writer";
import { wireHooks } from "../pipeline/subscribers/hooks";
import { wireInteraction } from "../pipeline/subscribers/interaction";
import { wireRegistry } from "../pipeline/subscribers/registry";
import { wireReporters } from "../pipeline/subscribers/reporters";
import type { PipelineContext } from "../pipeline/types";
import { countStories, isComplete, isStalled, loadPRD, markStoryFailed, markStoryPassed, savePRD } from "../prd";
import type { PRD } from "../prd/types";
import { resolveRouting } from "../routing";
import { cancellableDelay } from "../utils/bun-deps";
import { errorMessage } from "../utils/errors";
import { buildNaxIgnoreIndex } from "../utils/path-filters";
import { precomputeBatchPlan } from "./batching";
import { maybeSendCostWarning } from "./cost-warning";
import { startHeartbeat } from "./crash-recovery";
import { captureRunStartRef, type DeferredReviewResult, runDeferredReview } from "./deferred-review";
import { preIterationTierCheck, runBatchPreChecks } from "./escalation";
import type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";
import { agentFor, buildPreviewRouting } from "./executor-types";
import { getAllReadyStories } from "./helpers";
import { runIteration } from "./iteration-runner";
import { recordMergeConflictOutcomes } from "./merge-conflict-outcomes";
import type { RunParallelBatchOptions, RunParallelBatchResult } from "./parallel-batch";
import { synthesizeParallelStoryMetric } from "./parallel-story-metrics";
import { handlePipelineFailure } from "./pipeline-result-handler";
import { drainQueueAtBatchBoundary } from "./queue-handler";
import { closeStorySessions } from "./session-manager-runtime";
import { logStoryStart } from "./story-announce";
import { resolveRetryCandidate, selectIndependentBatch, selectNextStories } from "./story-selector";

export type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";

const TERMINAL_ACTIONS = new Set(["fail", "skip", "pause"]);

// Internal run-scoped unsubscribers; do not clear the bus because it has external subscribers.
let _prevRunUnsubscribers: Array<() => void> = [];
async function closeStoryIfTerminal(
  ctx: SequentialExecutionContext,
  storyId: string,
  iter: { storiesCompletedDelta: number; finalAction?: string },
): Promise<void> {
  const isTerminal = iter.storiesCompletedDelta > 0 || (iter.finalAction && TERMINAL_ACTIONS.has(iter.finalAction));
  if (!isTerminal) return;
  if (ctx.sessionManager) await closeStorySessions(ctx.sessionManager, storyId, ctx.agentGetFn);
  ctx.agentManager?.resetTransientUnavailable?.();
}

/**
 * BUG-6 / D-4: shared costLimit gate for all three dispatch paths (parallel batch,
 * single-story, sequential). Emits `run:paused` and returns `stop: true` unless the
 * cost-exceeded trigger is enabled and the user approves continuing (`run:resumed`).
 */
async function enforceCostLimit(
  ctx: SequentialExecutionContext,
  totalCost: number,
  costLimit: number,
  storyId?: string,
): Promise<{ stop: boolean; enforcedCost: number }> {
  const enforcedCost = Math.max(totalCost, ctx.runtime.costAggregator.snapshot().totalCostUsd);
  if (enforcedCost < costLimit) return { stop: false, enforcedCost };

  const shouldProceed =
    ctx.interactionChain && isTriggerEnabled("cost-exceeded", ctx.config)
      ? await checkCostExceeded(
          { featureName: ctx.feature, cost: enforcedCost, limit: costLimit },
          ctx.config,
          ctx.interactionChain,
        )
      : false;

  if (!shouldProceed) {
    pipelineEventBus.emit({
      type: "run:paused",
      reason: `Cost limit reached: $${enforcedCost.toFixed(2)}`,
      ...(storyId !== undefined ? { storyId } : {}),
      cost: enforcedCost,
    });
    return { stop: true, enforcedCost };
  }
  pipelineEventBus.emit({ type: "run:resumed", feature: ctx.feature });
  return { stop: false, enforcedCost };
}

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
  let lastStoryId: string | null = null; // feeds retry-priority (BUG-39)
  // Only cleared on preIterationTierCheck's terminal skip — a post-runIteration
  // terminal fail self-heals via markStoryFailed's attempts increment instead.
  const allStoryMetrics: StoryMetrics[] = [];
  let warningSent = false;
  let deferredReview: DeferredReviewResult | undefined;
  let deferredReviewStartedAt: number | undefined;

  const runStartRef = await captureRunStartRef(ctx.workdir);
  let cachedNaxIgnoreKey: string | undefined;
  const getRunNaxIgnoreIndex = async (currentPrd: PRD) => {
    const packageDirs = [
      ...new Set(
        currentPrd.userStories
          .map((s) => s.workdir)
          .filter((w): w is string => typeof w === "string" && w.length > 0)
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
    prd,
    iterations,
    storiesCompleted,
    totalCost,
    allStoryMetrics,
    exitReason,
    deferredReview,
    deferredReviewStartedAt,
  });

  startHeartbeat(
    ctx.statusWriter,
    () => totalCost,
    () => iterations,
    ctx.logFilePath,
  );

  let _executeThrew = false;
  try {
    if (isComplete(prd)) {
      logger?.info("execution", "All stories already complete — skipping pre-run pipeline");
      const naxIgnoreIndex = await getRunNaxIgnoreIndex(prd);
      deferredReviewStartedAt = Date.now();
      pipelineEventBus.emit({ type: "postrun:phase:started", phase: "review" });
      deferredReview = await runDeferredReview(
        ctx.workdir,
        ctx.config.review,
        ctx.pluginRegistry,
        runStartRef,
        naxIgnoreIndex,
      );
      return buildResult("completed");
    }

    // Pre-run pipeline (acceptance test setup with RED gate) — only when acceptance is configured
    let preRunCtx: PipelineContext | undefined;
    if (ctx.config.acceptance?.enabled) {
      logger?.info("execution", "Running pre-run pipeline (acceptance test setup)");
      const naxIgnoreIndex = await getRunNaxIgnoreIndex(prd);
      preRunCtx = {
        config: ctx.config,
        rootConfig: ctx.config,
        prd,
        projectDir: ctx.workdir,
        workdir: ctx.workdir,
        naxIgnoreIndex,
        featureDir: ctx.featureDir,
        story: prd.userStories[0],
        stories: prd.userStories,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
        hooks: ctx.hooks,
        agentGetFn: ctx.agentGetFn,
        agentManager: ctx.agentManager,
        sessionManager: ctx.sessionManager,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
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
      const naxIgnoreIndex = await getRunNaxIgnoreIndex(prd);
      const storyCounts = countStories(prd);
      logger?.debug("execution", "Loop iteration", {
        iteration: iterations,
        isComplete: isComplete(prd),
        passed: storyCounts.passed,
        pending: storyCounts.pending,
        failed: storyCounts.failed,
        total: storyCounts.total,
      });
      if (isComplete(prd)) {
        logger?.debug("execution", "All stories complete — entering completion path");
        if (ctx.interactionChain && isTriggerEnabled("pre-merge", ctx.config)) {
          const shouldProceed = await checkPreMerge(
            { featureName: ctx.feature, totalStories: prd.userStories.length, cost: totalCost },
            ctx.config,
            ctx.interactionChain,
          );
          if (!shouldProceed) return buildResult("pre-merge-aborted");
        }
        logger?.debug("execution", "Running deferred review");
        deferredReviewStartedAt = Date.now();
        pipelineEventBus.emit({ type: "postrun:phase:started", phase: "review" });
        deferredReview = await runDeferredReview(
          ctx.workdir,
          ctx.config.review,
          ctx.pluginRegistry,
          runStartRef,
          naxIgnoreIndex,
        );
        logger?.debug("execution", "Deferred review done — returning completed");
        return buildResult("completed");
      }

      const costLimit = ctx.config.execution.costLimit;
      // Parallel dispatch: when parallelCount > 0 and batch has more than 1 story
      if ((ctx.parallelCount ?? 0) > 0) {
        const retryStory = resolveRetryCandidate(prd, lastStoryId, ctx.config); // BUG-39: pre-empts selectIndependentBatch too
        const readyStories = getAllReadyStories(prd);
        const selectBatch = _unifiedExecutorDeps.selectIndependentBatch;
        const batch = retryStory ? [retryStory] : selectBatch(readyStories, ctx.parallelCount as number);
        if (batch.length > 1) {
          // BUG-7: pre-dispatch cost gate, mirroring the single-story path below (:481-484).
          {
            const batchCostPreCheck = await enforceCostLimit(ctx, totalCost, costLimit);
            if (batchCostPreCheck.stop) return buildResult("cost-limit");
          }
          // Emit story:started for each batch story before dispatch (AC-5) — stays here even for a
          // story the pre-check will refuse (see story-announce.ts, #1653). #1575: also record the
          // tier/agent so the story.start log below can never disagree with the event it accompanies.
          const batchAnnouncements = new Map<string, { modelTier: string; agent: string }>();
          for (const story of batch) {
            const modelTier = buildPreviewRouting(story, ctx.config).modelTier;
            const batchAgent = agentFor(story, ctx);
            batchAnnouncements.set(story.id, { modelTier, agent: batchAgent });
            pipelineEventBus.emit({
              type: "story:started",
              storyId: story.id,
              story: { id: story.id, title: story.title, status: story.status, attempts: story.attempts },
              workdir: ctx.workdir,
              modelTier,
              agent: batchAgent,
              iteration: iterations,
            });
          }

          const batchStartedAt = new Date().toISOString();
          const storyStartMs = new Map<string, number>();
          for (const s of batch) storyStartMs.set(s.id, Date.now());
          const batchPreCheck = await runBatchPreChecks({
            batch,
            prd,
            config: ctx.config,
            prdPath: ctx.prdPath,
            featureDir: ctx.featureDir,
            hooks: ctx.hooks,
            feature: ctx.feature,
            totalCost,
            workdir: ctx.workdir,
            preIterationTierCheckFn: _unifiedExecutorDeps.preIterationTierCheck,
            loadPRDFn: loadPRD,
            resolveRoutingFn: (story) => resolveRouting(story, ctx.config, ctx.pluginRegistry, ctx),
          });
          prd = batchPreCheck.prd;
          if (batchPreCheck.prdDirty) prdDirty = true;
          if (batchPreCheck.dispatchable.length === 0) {
            continue;
          }
          // #1653: announce only the stories that actually dispatch.
          for (const story of batchPreCheck.dispatchable) {
            const announcement = batchAnnouncements.get(story.id);
            logStoryStart(batchPreCheck.prd, story, {
              complexity: story.routing?.complexity ?? "unknown",
              modelTier: announcement?.modelTier ?? buildPreviewRouting(story, ctx.config).modelTier,
              agent: announcement?.agent ?? agentFor(story, ctx),
            });
          }
          const batchResult = await _unifiedExecutorDeps.runParallelBatch({
            stories: batchPreCheck.dispatchable,
            ctx: {
              workdir: ctx.workdir,
              config: ctx.config,
              hooks: ctx.hooks,
              pluginRegistry: ctx.pluginRegistry,
              maxConcurrency: ctx.parallelCount as number,
              pipelineContext: {
                config: ctx.config,
                rootConfig: ctx.config,
                prd,
                skipPrdPersistence: true, // CR-1: worktree pipelines must not persist PRD
                prdPath: ctx.prdPath, // BUG-36: carried through to the rectification re-run
                projectDir: ctx.workdir,
                naxIgnoreIndex,
                hooks: ctx.hooks,
                featureDir: ctx.featureDir,
                agentGetFn: ctx.agentGetFn,
                agentManager: ctx.agentManager,
                sessionManager: ctx.sessionManager,
                runtime: ctx.runtime,
                abortSignal: ctx.abortSignal,
              },
              eventEmitter: ctx.eventEmitter,
              agentGetFn: ctx.agentGetFn,
            },
            prd,
          });
          // Route parallel failures through handlePipelineFailure (AC-6)
          for (const { story, pipelineResult } of batchResult.failed) {
            const storyRouting = prd.userStories.find((s) => s.id === story.id)?.routing;
            // BUG-04: capture the escalated prd, or canEscalate never trips.
            const failureResult = await handlePipelineFailure(
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
                agentManager: ctx.agentManager,
                sessionManager: ctx.sessionManager,
                runtime: ctx.runtime,
                abortSignal: ctx.abortSignal,
              },
              pipelineResult,
            );
            // (Cost not re-added: batchResult.totalCost below already includes it.)
            prd = failureResult.prd;
          }

          // Single-writer PRD reconciliation (H-1): worktree pipelines skipped persistence, so record completed + merge-conflict outcomes here.
          reconcileBatchOutcome(prd, batchResult);
          const queueDrain = await drainQueueAtBatchBoundary(ctx.workdir, prd); // BUG-9
          await savePRD(prd, ctx.prdPath);
          await pipelineEventBus.drain();
          totalCost += batchResult.totalCost;
          storiesCompleted +=
            batchResult.completed.length + batchResult.mergeConflicts.filter((c) => c.rectified).length;
          prdDirty = true;
          if (ctx.sessionManager) {
            for (const story of batchResult.completed) {
              await closeStorySessions(ctx.sessionManager, story.id, ctx.agentGetFn);
            }
            for (const failed of batchResult.failed) {
              if (failed.pipelineResult.finalAction && TERMINAL_ACTIONS.has(failed.pipelineResult.finalAction)) {
                await closeStorySessions(ctx.sessionManager, failed.story.id, ctx.agentGetFn);
              }
            }
          }
          ctx.agentManager?.resetTransientUnavailable?.();
          // Build per-story metrics for completed parallel batch stories
          const batchCompletedAt = new Date().toISOString();
          for (const story of batchResult.completed) {
            const storyCost = batchResult.storyCosts.get(story.id) ?? 0;
            const storyStartTime = storyStartMs.get(story.id) ?? Date.now();
            // Prefer per-story duration from the batch (worktree creation → merge completion per AC-2).
            // Falls back to elapsed time since storyStartMs was recorded (set just before the batch
            // call), which is a slightly wider window but only applies when storyDurations is absent.
            const storyDuration = batchResult.storyDurations?.get(story.id) ?? Date.now() - storyStartTime;
            allStoryMetrics.push(
              synthesizeParallelStoryMetric({
                story,
                // #1575: the story's own agent — these metrics feed per-agent cost attribution.
                modelUsed: agentFor(story, ctx),
                cost: storyCost,
                durationMs: storyDuration,
                startedAt: batchStartedAt,
                completedAt: batchCompletedAt,
                source: "parallel",
                firstPassSuccess: true,
                fallbackHops: toFallbackHops(ctx.runtime.agentFallbacks.get(story.id), story.id),
                runtimeCrashes: ctx.runtime.runtimeCrashRetries.get(story.id) ?? 0,
              }),
            );
          }

          // Build metrics for merge-conflict stories, rectified or not (AC-3, BUG-3);
          // also corrects the bus + progress log for the non-rectified case.
          await recordMergeConflictOutcomes({
            ctx,
            prd,
            mergeConflicts: batchResult.mergeConflicts,
            storyCosts: batchResult.storyCosts,
            storyDurations: batchResult.storyDurations,
            storyStartMs,
            batchStartedAt,
            batchCompletedAt,
            allStoryMetrics,
          });

          // BUG-13: mirror sequential/single-story dispatch below (statusWriter update).
          ctx.statusWriter.setPrd(prd);
          ctx.statusWriter.setCurrentStory(null);
          await ctx.statusWriter.update(totalCost, iterations);

          if (queueDrain.paused) return buildResult("queue-paused"); // BUG-9: stop dispatching further batches
          // Cost-limit check after parallel batch (AC-7). BUG-6 / D-4: parity via enforceCostLimit.
          const batchCostCheck = await enforceCostLimit(ctx, totalCost, costLimit);
          if (batchCostCheck.stop) return buildResult("cost-limit");

          warningSent = await maybeSendCostWarning(ctx, batchCostCheck.enforcedCost, costLimit, warningSent);

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

          lastStoryId = singleStory.id; // BUG-39: unconditional (was !ctx.useBatch-gated)

          {
            const singleCostCheck = await enforceCostLimit(ctx, totalCost, costLimit, singleStory.id);
            if (singleCostCheck.stop) return buildResult("cost-limit");
          }

          const modelTier = singleSelection.routing.modelTier;
          const singleAgent = agentFor(singleStory, ctx);
          pipelineEventBus.emit({
            type: "story:started",
            storyId: singleStory.id,
            story: {
              id: singleStory.id,
              title: singleStory.title,
              status: singleStory.status,
              attempts: singleStory.attempts,
            },
            workdir: ctx.workdir,
            modelTier,
            agent: singleAgent,
            iteration: iterations,
          });
          const singlePre = await _unifiedExecutorDeps.preIterationTierCheck(
            singleStory,
            singleSelection.routing,
            ctx.config,
            prd,
            ctx.prdPath,
            ctx.featureDir,
            ctx.hooks,
            ctx.feature,
            totalCost,
            ctx.workdir,
            ctx.runtime,
            (story) => resolveRouting(story, ctx.config, ctx.pluginRegistry, ctx),
          );
          if (singlePre.shouldSkipIteration) {
            if (singlePre.prd.userStories.find((s) => s.id === singleStory.id)?.status === "failed") lastStoryId = null; // BUG-39
            prdDirty = singlePre.prdDirty;
            continue;
          }

          // #1653: announced only after the pre-check clears the attempt to run.
          logStoryStart(prd, singleStory, {
            complexity: singleSelection.routing.complexity ?? "unknown",
            modelTier,
            agent: singleAgent,
          });

          const singleIter = await _unifiedExecutorDeps.runIteration(
            ctx,
            prd,
            singleSelection,
            iterations,
            totalCost,
            allStoryMetrics,
          );
          await pipelineEventBus.drain();
          [prd, storiesCompleted, totalCost, prdDirty] = [
            singleIter.prd,
            storiesCompleted + singleIter.storiesCompletedDelta,
            totalCost + singleIter.costDelta,
            singleIter.prdDirty,
          ];
          await closeStoryIfTerminal(ctx, singleStory.id, singleIter);
          if (singleIter.prdDirty) {
            prd = await loadPRD(ctx.prdPath);
            prdDirty = false;
          }
          ctx.statusWriter.setPrd(prd);
          ctx.statusWriter.setCurrentStory(null);
          await ctx.statusWriter.update(totalCost, iterations);

          if (isStalled(prd, ctx.config.execution.rectification?.maxAttemptsTotal)) {
            pipelineEventBus.emit({ type: "run:paused", reason: "All remaining stories blocked", cost: totalCost });
            return buildResult("stalled");
          }
          // BUG-2 fix: treat an aborted delay as a clean stop. Without
          // this, the rejection escapes executeUnified and races the
          // signal handler's own teardown + process.exit(130) (see
          // docs/20260816-review-since-0.80.0-canary.3.md).
          try {
            await cancellableDelay(ctx.config.execution.iterationDelayMs, ctx.runtime.signal);
          } catch (err) {
            if (ctx.runtime.signal.aborted) {
              logger?.info("execution", "Iteration delay aborted — exiting cleanly", {
                iterations,
                reason: errorMessage(err),
              });
              return buildResult("aborted");
            }
            throw err;
          }
          continue;
        }
        // batch.length === 0: fall through to sequential single-story path
      }

      // Sequential single-story dispatch
      const currentBatchPlan = ctx.useBatch ? precomputeBatchPlan(getAllReadyStories(prd), 4) : ctx.batchPlan;
      const selected = selectNextStories(prd, ctx.config, currentBatchPlan, 0, lastStoryId, ctx.useBatch);
      if (!selected) return buildResult("no-stories");
      const { selection } = selected;
      if (!selection) return buildResult("no-stories"); // defensive: type contract guarantees non-null when selected is non-null
      lastStoryId = selection.story.id; // BUG-39: unconditional (was !ctx.useBatch-gated)

      {
        const seqCostCheck = await enforceCostLimit(ctx, totalCost, costLimit, selection.story.id);
        if (seqCostCheck.stop) return buildResult("cost-limit");
      }

      const modelTier = selection.routing.modelTier;
      const seqAgent = agentFor(selection.story, ctx);
      pipelineEventBus.emit({
        type: "story:started",
        storyId: selection.story.id,
        story: {
          id: selection.story.id,
          title: selection.story.title,
          status: selection.story.status,
          attempts: selection.story.attempts,
        },
        workdir: ctx.workdir,
        modelTier,
        agent: seqAgent,
        iteration: iterations,
      });
      const seqPre = await _unifiedExecutorDeps.preIterationTierCheck(
        selection.story,
        selection.routing,
        ctx.config,
        prd,
        ctx.prdPath,
        ctx.featureDir,
        ctx.hooks,
        ctx.feature,
        totalCost,
        ctx.workdir,
        ctx.runtime,
      );
      if (seqPre.shouldSkipIteration) {
        if (seqPre.prd.userStories.find((s) => s.id === selection.story.id)?.status === "failed") lastStoryId = null; // BUG-39
        prdDirty = seqPre.prdDirty;
        continue;
      }

      // #1653: announced only after the pre-check clears the attempt to run.
      logStoryStart(prd, selection.story, {
        complexity: selection.routing.complexity ?? "unknown",
        modelTier,
        agent: seqAgent,
      });

      const iter = await _unifiedExecutorDeps.runIteration(ctx, prd, selection, iterations, totalCost, allStoryMetrics);
      await pipelineEventBus.drain();
      [prd, storiesCompleted, totalCost, prdDirty] = [
        iter.prd,
        storiesCompleted + iter.storiesCompletedDelta,
        totalCost + iter.costDelta,
        iter.prdDirty,
      ];
      await closeStoryIfTerminal(ctx, selection.story.id, iter);
      warningSent = await maybeSendCostWarning(
        ctx,
        Math.max(totalCost, ctx.runtime.costAggregator.snapshot().totalCostUsd),
        costLimit,
        warningSent,
      );

      if (iter.prdDirty) {
        prd = await loadPRD(ctx.prdPath);
        prdDirty = false;
      }
      ctx.statusWriter.setPrd(prd);
      ctx.statusWriter.setCurrentStory(null);
      await ctx.statusWriter.update(totalCost, iterations);

      if (isStalled(prd, ctx.config.execution.rectification?.maxAttemptsTotal)) {
        pipelineEventBus.emit({ type: "run:paused", reason: "All remaining stories blocked", cost: totalCost });
        return buildResult("stalled");
      }
      // BUG-2 fix: same handling as the parallel-batch delay above — an
      // aborted delay is a clean stop, not an exception that escapes
      // into the runner's finally.
      try {
        await cancellableDelay(ctx.config.execution.iterationDelayMs, ctx.runtime.signal);
      } catch (err) {
        if (ctx.runtime.signal.aborted) {
          logger?.info("execution", "Iteration delay aborted — exiting cleanly", {
            iterations,
            reason: errorMessage(err),
          });
          return buildResult("aborted");
        }
        throw err;
      }
    }

    // Post-run pipeline (acceptance tests) — only when acceptance is configured
    if (ctx.config.acceptance?.enabled) {
      logger?.info("execution", "Running post-run pipeline (acceptance tests)");
      await runPipeline(
        postRunPipeline,
        {
          config: ctx.config,
          rootConfig: ctx.config,
          prd,
          workdir: ctx.workdir,
          projectDir: ctx.workdir,
          featureDir: ctx.featureDir,
          story: prd.userStories[0],
          stories: prd.userStories,
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
/**
 * Single-writer reconciliation of a parallel batch outcome onto the in-memory PRD.
 * Worktree pipelines no longer persist PRD (skipPrdPersistence), so the executor
 * is the authority for:
 *   - completed       → passed
 *   - mergeConflicts  → passed iff rectified, else failed
 * FAILED stories are intentionally NOT handled here — handlePipelineFailure
 * (pipeline-result-handler.ts) already marks + saves them; touching them again
 * double-increments attempts.
 *
 * PRD state ONLY (BUG-3, nax review 20260829). This function is deliberately a pure
 * `(prd, batchResult) => void` with no access to `ctx`, `featureDir`, or the cost
 * aggregator, so it cannot also correct the event bus or per-agent cost attribution for
 * a non-rectified merge conflict. That correction — emitting `story:failed`, appending
 * progress, and synthesizing a StoryMetric — is `recordMergeConflictOutcomes`
 * (merge-conflict-outcomes.ts), called from the batch loop right after this function.
 * Do not read this function's return (`void`) as proof a non-rectified conflict is
 * fully handled — check the caller too.
 */
export function reconcileBatchOutcome(
  prd: PRD,
  batchResult: Pick<RunParallelBatchResult, "completed" | "mergeConflicts">,
): void {
  for (const story of batchResult.completed) {
    markStoryPassed(prd, story.id);
  }
  for (const conflict of batchResult.mergeConflicts) {
    if (conflict.rectified) {
      markStoryPassed(prd, conflict.story.id);
    } else {
      markStoryFailed(prd, conflict.story.id, undefined, "merge-conflict");
    }
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
  preIterationTierCheck,
};
