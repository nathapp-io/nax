/**
 * The two parallel-batch dispatch shapes for `executeUnified`
 * (./unified-executor.ts) — split from ./unified-executor-dispatch-phases.ts
 * (docs/plans/STATUS-complexity-drain.md A1) so neither file grows past the
 * 600-line gate. See that file for the shared `LoopState` / `DispatchStep`
 * shape and the `_unifiedExecutorDeps` DI note.
 */

import { pipelineEventBus } from "@/pipeline/event-bus";
import { type StoryMetrics, toFallbackHops } from "../metrics";
import { isStalled, loadPRD, savePRD } from "../prd";
import type { PRD, UserStory } from "../prd/types";
import { resolveRouting } from "../routing";
import { storyPackageDir } from "../utils/path-frame";
import { enforceCostLimit } from "./cost-guard";
import { maybeSendCostWarning } from "./cost-warning";
import { type preIterationTierCheck, runBatchPreChecks } from "./escalation";
import { agentFor, buildPreviewRouting, type SequentialExecutionContext } from "./executor-types";
import { getAllReadyStories } from "./helpers";
import type { runIteration } from "./iteration-runner";
import { recordMergeConflictOutcomes } from "./merge-conflict-outcomes";
import type { RunParallelBatchOptions, RunParallelBatchResult } from "./parallel-batch";
import { synthesizeParallelStoryMetric } from "./parallel-story-metrics";
import { handlePipelineFailure } from "./pipeline-result-handler";
import { drainQueueAtBatchBoundary } from "./queue-handler";
import { reconcileBatchOutcome } from "./reconcile-batch-outcome";
import { reconcileRunCost } from "./run-cost-reconcile";
import { closeStorySessions } from "./session-manager-runtime";
import { logStoryStart } from "./story-announce";
import { resolveRetryCandidate, type selectIndependentBatch } from "./story-selector";
import {
  closeStoryIfTerminal,
  type DispatchPhaseParams,
  type DispatchStep,
  runIterationDelay,
  TERMINAL_ACTIONS,
} from "./unified-executor-dispatch-phases";

export interface ParallelDispatchDeps {
  selectIndependentBatch: typeof selectIndependentBatch;
  preIterationTierCheck: typeof preIterationTierCheck;
  runParallelBatch: (opts: RunParallelBatchOptions) => Promise<RunParallelBatchResult>;
  runIteration: typeof runIteration;
}

/** Routes each of a parallel batch's failed stories through handlePipelineFailure (AC-6), folding the escalated PRD in. */
async function handleParallelBatchFailures(
  ctx: SequentialExecutionContext,
  prd: PRD,
  totalCost: number,
  allStoryMetrics: StoryMetrics[],
  batchResult: RunParallelBatchResult,
): Promise<PRD> {
  let nextPrd = prd;
  for (const { story, pipelineResult } of batchResult.failed) {
    const storyRouting = nextPrd.userStories.find((s) => s.id === story.id)?.routing;
    // BUG-04: capture the escalated prd, or canEscalate never trips.
    const failureResult = await handlePipelineFailure(
      {
        config: ctx.config,
        prd: nextPrd,
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
    nextPrd = failureResult.prd;
  }
  return nextPrd;
}

async function closeParallelBatchSessions(
  ctx: SequentialExecutionContext,
  batchResult: RunParallelBatchResult,
): Promise<void> {
  if (!ctx.sessionManager) return;
  for (const story of batchResult.completed) {
    await closeStorySessions(ctx.sessionManager, story.id, ctx.agentGetFn);
  }
  for (const failed of batchResult.failed) {
    if (failed.pipelineResult.finalAction && TERMINAL_ACTIONS.has(failed.pipelineResult.finalAction)) {
      await closeStorySessions(ctx.sessionManager, failed.story.id, ctx.agentGetFn);
    }
  }
}

function toFallbackHopsFor(ctx: SequentialExecutionContext, storyId: string) {
  return toFallbackHops(ctx.runtime.agentFallbacks.get(storyId), storyId);
}

/**
 * The many-story branch of parallel dispatch (`batch.length > 1`): a pre-dispatch
 * cost gate, running the batch through worktree pipelines, then reconciling the
 * PRD, cost, metrics and queue state the batch touched.
 */
async function runManyStoryParallelBatch(
  batch: UserStory[],
  params: DispatchPhaseParams,
  deps: ParallelDispatchDeps,
): Promise<DispatchStep> {
  const { ctx, state, iterations, allStoryMetrics, naxIgnoreIndex, costLimit } = params;
  let { prd, totalCost, storiesCompleted, prdDirty, warningSent } = state;
  const { lastStoryId } = state;

  // BUG-7: pre-dispatch cost gate, mirroring the single-story path below.
  {
    const batchCostPreCheck = await enforceCostLimit(ctx, totalCost, costLimit);
    if (batchCostPreCheck.stop) return { action: "return", state, exitReason: "cost-limit" };
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
    preIterationTierCheckFn: deps.preIterationTierCheck,
    loadPRDFn: loadPRD,
    resolveRoutingFn: (story) => resolveRouting(story, ctx.config, ctx.pluginRegistry, ctx),
  });
  prd = batchPreCheck.prd;
  if (batchPreCheck.prdDirty) prdDirty = true;
  if (batchPreCheck.dispatchable.length === 0) {
    return { action: "continue", state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent } };
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
  const batchResult = await deps.runParallelBatch({
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
        runStoryWorkdirs: prd.userStories.map(storyPackageDir),
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
  prd = await handleParallelBatchFailures(ctx, prd, totalCost, allStoryMetrics, batchResult);

  // Single-writer PRD reconciliation (H-1): worktree pipelines skipped persistence, so record completed + merge-conflict outcomes here.
  reconcileBatchOutcome(prd, batchResult);
  const queueDrain = await drainQueueAtBatchBoundary(ctx.workdir, prd); // BUG-9
  await savePRD(prd, ctx.prdPath);
  await pipelineEventBus.drain();
  // #2006: fold in aggregator spend the phaseCosts sum cannot see (pre-run pipeline, failed dispatches).
  totalCost = reconcileRunCost(totalCost + batchResult.totalCost, ctx.runtime.costAggregator);
  storiesCompleted += batchResult.completed.length + batchResult.mergeConflicts.filter((c) => c.rectified).length;
  prdDirty = true;
  await closeParallelBatchSessions(ctx, batchResult);
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
        fallbackHops: toFallbackHopsFor(ctx, story.id),
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

  if (queueDrain.paused) {
    // BUG-9: stop dispatching further batches
    return {
      action: "return",
      state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
      exitReason: "queue-paused",
    };
  }
  // Cost-limit check after parallel batch (AC-7). BUG-6 / D-4: parity via enforceCostLimit.
  const batchCostCheck = await enforceCostLimit(ctx, totalCost, costLimit);
  if (batchCostCheck.stop) {
    return {
      action: "return",
      state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
      exitReason: "cost-limit",
    };
  }

  warningSent = await maybeSendCostWarning(ctx, batchCostCheck.enforcedCost, costLimit, warningSent);

  return { action: "continue", state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent } };
}

/**
 * The single-story branch of parallel dispatch (`batch.length === 1`): dispatch
 * the one story the batch selector chose, honouring its dependency/priority
 * logic rather than re-running `selectNextStories`.
 */
async function runSingleStoryInBatch(
  singleStory: UserStory,
  params: DispatchPhaseParams,
  deps: ParallelDispatchDeps,
): Promise<DispatchStep> {
  const { ctx, state, iterations, allStoryMetrics, costLimit } = params;
  let { prd, totalCost, storiesCompleted, prdDirty } = state;
  const { warningSent } = state;
  let lastStoryId: string | null = singleStory.id; // BUG-39: unconditional (was !ctx.useBatch-gated)

  const singleSelection = {
    story: singleStory,
    storiesToExecute: [singleStory],
    routing: buildPreviewRouting(singleStory, ctx.config),
    isBatchExecution: false,
  };

  {
    const singleCostCheck = await enforceCostLimit(ctx, totalCost, costLimit, singleStory.id);
    if (singleCostCheck.stop) {
      return {
        action: "return",
        state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
        exitReason: "cost-limit",
      };
    }
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
  const singlePre = await deps.preIterationTierCheck(
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
    return {
      action: "continue",
      state: {
        prd: singlePre.prd,
        prdDirty: singlePre.prdDirty,
        totalCost,
        storiesCompleted,
        lastStoryId,
        warningSent,
      },
    };
  }

  // #1653: announced only after the pre-check clears the attempt to run.
  logStoryStart(prd, singleStory, {
    complexity: singleSelection.routing.complexity ?? "unknown",
    modelTier,
    agent: singleAgent,
  });

  const singleIter = await deps.runIteration(ctx, prd, singleSelection, iterations, totalCost, allStoryMetrics);
  await pipelineEventBus.drain();
  prd = singleIter.prd;
  storiesCompleted += singleIter.storiesCompletedDelta;
  totalCost = reconcileRunCost(totalCost + singleIter.costDelta, ctx.runtime.costAggregator);
  prdDirty = singleIter.prdDirty;
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
    return {
      action: "return",
      state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
      exitReason: "stalled",
    };
  }
  // BUG-2 fix: treat an aborted delay as a clean stop. Without this, the
  // rejection escapes executeUnified and races the signal handler's own
  // teardown + process.exit(130).
  const delayOutcome = await runIterationDelay(ctx, iterations);
  if (delayOutcome.aborted) {
    return {
      action: "return",
      state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent },
      exitReason: "aborted",
    };
  }

  return { action: "continue", state: { prd, prdDirty, totalCost, storiesCompleted, lastStoryId, warningSent } };
}

/**
 * Parallel dispatch (`ctx.parallelCount > 0 && !ctx.dryRun`): select a batch and
 * hand it to whichever shape applies. `batch.length === 0` falls through so the
 * caller runs sequential dispatch instead.
 */
export async function runParallelDispatch(
  params: DispatchPhaseParams,
  deps: ParallelDispatchDeps,
): Promise<DispatchStep> {
  const { ctx, state } = params;
  const retryStory = resolveRetryCandidate(state.prd, state.lastStoryId, ctx.config); // BUG-39: pre-empts selectIndependentBatch too
  const readyStories = getAllReadyStories(state.prd);
  const batch = retryStory ? [retryStory] : deps.selectIndependentBatch(readyStories, ctx.parallelCount as number);
  if (batch.length > 1) return runManyStoryParallelBatch(batch, params, deps);
  if (batch.length === 1) {
    const singleStory = batch[0];
    if (!singleStory) return { action: "fallthrough", state };
    return runSingleStoryInBatch(singleStory, params, deps);
  }
  return { action: "fallthrough", state };
}
