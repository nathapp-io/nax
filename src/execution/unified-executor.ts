/** Unified Story Executor (ADR-005, Phase 4) — sequential loop with optional parallel dispatch. */

import { pipelineEventBus } from "@/pipeline";
import { resolveDefaultAgent } from "../agents";
import { checkCostExceeded, checkCostWarning, checkPreMerge, isTriggerEnabled } from "../interaction/triggers";
import { getSafeLogger } from "../logger";
import type { StoryMetrics } from "../metrics";
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
import { buildNaxIgnoreIndex } from "../utils/path-filters";
import { precomputeBatchPlan } from "./batching";
import { startHeartbeat } from "./crash-recovery";
import { captureRunStartRef, runDeferredReview } from "./deferred-review";
import type { DeferredReviewResult } from "./deferred-review";
import type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";
import { buildPreviewRouting } from "./executor-types";
import { getAllReadyStories } from "./helpers";
import { runIteration } from "./iteration-runner";
import type { RunParallelBatchOptions, RunParallelBatchResult } from "./parallel-batch";
import { handlePipelineFailure } from "./pipeline-result-handler";
import { closeStorySessions } from "./session-manager-runtime";
import { selectIndependentBatch, selectNextStories } from "./story-selector";

export type { SequentialExecutionContext, SequentialExecutionResult } from "./executor-types";

const TERMINAL_ACTIONS = new Set(["fail", "skip", "pause"]);

// Tracks internal run-scoped unsubscribers so we can tear them down without
// calling pipelineEventBus.clear(), which would also wipe external subscribers
// like the TUI's usePipelineBusEvents hook.
let _prevRunUnsubscribers: Array<() => void> = [];

async function closeStoryIfTerminal(
  ctx: SequentialExecutionContext,
  storyId: string,
  iter: { storiesCompletedDelta: number; finalAction?: string },
): Promise<void> {
  if (!ctx.sessionManager) return;
  if (iter.storiesCompletedDelta > 0 || (iter.finalAction && TERMINAL_ACTIONS.has(iter.finalAction))) {
    await closeStorySessions(ctx.sessionManager, storyId, ctx.agentGetFn);
  }
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
  let lastStoryId: string | null = null;
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
    wireReporters(pipelineEventBus, ctx.pluginRegistry, ctx.runId, ctx.startTime),
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
        const readyStories = getAllReadyStories(prd);
        const batch = _unifiedExecutorDeps.selectIndependentBatch(readyStories, ctx.parallelCount as number);

        if (batch.length > 1) {
          // Emit story:started for each batch story before dispatch (AC-5)
          const batchAgent = ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config);
          const batchCounts = countStories(prd);
          const batchBaseDone = batchCounts.total - batchCounts.pending;
          for (const [batchIndex, story] of batch.entries()) {
            const modelTier =
              story.routing?.modelTier ??
              ctx.config.autoMode.complexityRouting?.[story.routing?.complexity ?? "medium"] ??
              "balanced";
            pipelineEventBus.emit({
              type: "story:started",
              storyId: story.id,
              story: { id: story.id, title: story.title, status: story.status, attempts: story.attempts },
              workdir: ctx.workdir,
              modelTier,
              agent: batchAgent,
              iteration: iterations,
            });
            logger?.info("story.start", `${story.title}`, {
              storyId: story.id,
              storyTitle: story.title,
              complexity: story.routing?.complexity ?? "unknown",
              modelTier,
              agent: batchAgent,
              storyNumber: batchBaseDone + batchIndex + 1,
              storyTotal: batchCounts.total,
              attempt: story.attempts + 1,
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
                rootConfig: ctx.config,
                prd,
                skipPrdPersistence: true, // CR-1: worktree pipelines must not persist PRD
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
                agentManager: ctx.agentManager,
                sessionManager: ctx.sessionManager,
                runtime: ctx.runtime,
                abortSignal: ctx.abortSignal,
              },
              pipelineResult,
            );
          }

          // Single-writer PRD reconciliation (H-1): worktree pipelines skipped
          // persistence, so record completed + merge-conflict outcomes here.
          reconcileBatchOutcome(prd, batchResult);
          await savePRD(prd, ctx.prdPath);

          await pipelineEventBus.drain();
          totalCost += batchResult.totalCost;
          storiesCompleted += batchResult.completed.length;
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

          // Build per-story metrics for completed parallel batch stories
          const batchCompletedAt = new Date().toISOString();
          for (const story of batchResult.completed) {
            const storyCost = batchResult.storyCosts.get(story.id) ?? 0;
            const storyStartTime = storyStartMs.get(story.id) ?? Date.now();
            // Prefer per-story duration from the batch (worktree creation → merge completion per AC-2).
            // Falls back to elapsed time since storyStartMs was recorded (set just before the batch
            // call), which is a slightly wider window but only applies when storyDurations is absent.
            const storyDuration = batchResult.storyDurations?.get(story.id) ?? Date.now() - storyStartTime;
            allStoryMetrics.push({
              storyId: story.id,
              complexity: story.routing?.complexity ?? "medium",
              modelTier: story.routing?.modelTier ?? "balanced",
              modelUsed: ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config),
              attempts: 1,
              finalTier: story.routing?.modelTier ?? "balanced",
              success: true,
              cost: storyCost,
              durationMs: storyDuration,
              firstPassSuccess: true,
              startedAt: batchStartedAt,
              completedAt: batchCompletedAt,
              source: "parallel" as const,
            });
          }

          // Build metrics for rectified merge-conflict stories (AC-3)
          for (const conflict of batchResult.mergeConflicts) {
            if (conflict.rectified) {
              const storyStartTime = storyStartMs.get(conflict.story.id) ?? Date.now();
              const storyDuration = batchResult.storyDurations?.get(conflict.story.id) ?? Date.now() - storyStartTime;
              allStoryMetrics.push({
                storyId: conflict.story.id,
                complexity: conflict.story.routing?.complexity ?? "medium",
                modelTier: conflict.story.routing?.modelTier ?? "balanced",
                modelUsed: ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config),
                attempts: 1,
                finalTier: conflict.story.routing?.modelTier ?? "balanced",
                success: true,
                // cost = total per-story agent cost including rectification work.
                // rectificationCost = only the conflict resolution portion (conflict.cost).
                cost: batchResult.storyCosts.get(conflict.story.id) ?? 0,
                durationMs: storyDuration,
                firstPassSuccess: false,
                startedAt: batchStartedAt,
                completedAt: batchCompletedAt,
                source: "rectification" as const,
                rectificationCost: conflict.cost,
              });
            }
          }

          // Cost-limit check after parallel batch (AC-7)
          // Consult the aggregator so completion-phase spend cannot silently bypass the limit.
          const enforcedCostAfterBatch = Math.max(totalCost, ctx.runtime.costAggregator.snapshot().totalCostUsd);
          if (enforcedCostAfterBatch >= costLimit) {
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

          {
            // Consult the aggregator so completion-phase spend cannot silently bypass the limit.
            const enforcedCostSingle = Math.max(totalCost, ctx.runtime.costAggregator.snapshot().totalCostUsd);
            if (enforcedCostSingle >= costLimit) {
              const shouldProceed =
                ctx.interactionChain && isTriggerEnabled("cost-exceeded", ctx.config)
                  ? await checkCostExceeded(
                      { featureName: ctx.feature, cost: enforcedCostSingle, limit: costLimit },
                      ctx.config,
                      ctx.interactionChain,
                    )
                  : false;
              if (!shouldProceed) {
                pipelineEventBus.emit({
                  type: "run:paused",
                  reason: `Cost limit reached: $${enforcedCostSingle.toFixed(2)}`,
                  storyId: singleStory.id,
                  cost: enforcedCostSingle,
                });
                return buildResult("cost-limit");
              }
              pipelineEventBus.emit({ type: "run:resumed", feature: ctx.feature });
            }
          }

          const modelTier = singleSelection.routing.modelTier;
          const singleAgent = ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config);
          const singleCounts = countStories(prd);
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
          logger?.info("story.start", `${singleStory.title}`, {
            storyId: singleStory.id,
            storyTitle: singleStory.title,
            complexity: singleSelection.routing.complexity ?? "unknown",
            modelTier,
            agent: singleAgent,
            storyNumber: singleCounts.total - singleCounts.pending + 1,
            storyTotal: singleCounts.total,
            attempt: singleStory.attempts + 1,
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
      const currentBatchPlan = ctx.useBatch ? precomputeBatchPlan(getAllReadyStories(prd), 4) : ctx.batchPlan;
      const selected = selectNextStories(prd, ctx.config, currentBatchPlan, 0, lastStoryId, ctx.useBatch);
      if (!selected) return buildResult("no-stories");
      const { selection } = selected;
      if (!selection) return buildResult("no-stories"); // defensive: type contract guarantees non-null when selected is non-null
      if (!ctx.useBatch) lastStoryId = selection.story.id;

      {
        // Consult the aggregator so completion-phase spend cannot silently bypass the limit.
        const enforcedCostSeq = Math.max(totalCost, ctx.runtime.costAggregator.snapshot().totalCostUsd);
        if (enforcedCostSeq >= costLimit) {
          const shouldProceed =
            ctx.interactionChain && isTriggerEnabled("cost-exceeded", ctx.config)
              ? await checkCostExceeded(
                  { featureName: ctx.feature, cost: enforcedCostSeq, limit: costLimit },
                  ctx.config,
                  ctx.interactionChain,
                )
              : false;
          if (!shouldProceed) {
            pipelineEventBus.emit({
              type: "run:paused",
              reason: `Cost limit reached: $${enforcedCostSeq.toFixed(2)}`,
              storyId: selection.story.id,
              cost: enforcedCostSeq,
            });
            return buildResult("cost-limit");
          }
          pipelineEventBus.emit({ type: "run:resumed", feature: ctx.feature });
        }
      }

      const modelTier = selection.routing.modelTier;
      const seqAgent = ctx.agentManager?.getDefault() ?? resolveDefaultAgent(ctx.config);
      const seqCounts = countStories(prd);
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
      logger?.info("story.start", `${selection.story.title}`, {
        storyId: selection.story.id,
        storyTitle: selection.story.title,
        complexity: selection.routing.complexity ?? "unknown",
        modelTier,
        agent: seqAgent,
        storyNumber: seqCounts.total - seqCounts.pending + 1,
        storyTotal: seqCounts.total,
        attempt: selection.story.attempts + 1,
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

      if (ctx.interactionChain && isTriggerEnabled("cost-warning", ctx.config) && !warningSent) {
        const triggerCfg = ctx.config.interaction?.triggers?.["cost-warning"];
        const threshold = typeof triggerCfg === "object" ? (triggerCfg.threshold ?? 0.8) : 0.8;
        const enforcedCostWarn = Math.max(totalCost, ctx.runtime.costAggregator.snapshot().totalCostUsd);
        if (enforcedCostWarn >= costLimit * threshold) {
          await checkCostWarning(
            { featureName: ctx.feature, cost: enforcedCostWarn, limit: costLimit },
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
};
