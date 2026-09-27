/**
 * Run completion — post-gate phases (review, costs, teardown, reporting).
 *
 * Extracted from run-completion.ts (complexity-drain batch A9). After the
 * deferred regression gate, handleRunCompletion is a linear sequence of
 * phases; each one below is a named function that reads exactly like the
 * original inline block it replaced:
 *
 *   1. consumeDeferredReview — deferred plugin review consumption (#1146 G2)
 *   2. snapshotCostsAndBackfill — aggregator totals + story-metrics backfill
 *   3. teardownRunSessions — session teardown + plugin-provider disposal
 *   4. emitRunCompletedAndSaveMetrics — run:completed event + metrics save
 *   5. purgeStaleRunArtifacts — session scratch (AC-20) + manifests (US-002)
 *   6. logRunCompletion — the completion summary log
 *   7. writeFinalStatus — the final status.json run status
 *
 * Phases that call a `_runCompletionDeps` member receive it BY REFERENCE as
 * `deps` and read `deps.X` at call time (the seam stays in run-completion.ts,
 * re-exported through the lifecycle barrel for tests to mutate). This file
 * imports run-completion.ts TYPE-ONLY; a runtime import would cycle back to
 * the seam (the A1 trap from complexity-drain §9.2).
 */

import { resolveDefaultAgent } from "@/agents";
import type { NaxConfig } from "@/config";
import type { purgeStaleManifests } from "@/context/engine";
import type { Logger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import { deriveRunFallbackAggregates, saveRunMetrics } from "@/metrics";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD } from "@/prd";
import { countStories, isComplete, isStalled } from "@/prd";
import { totalSpendUsd } from "@/runtime";
import { purgeStaleScratch } from "@/session";
import type { closeAllRunSessions } from "../session-manager-runtime";
import type { StatusWriter } from "../status-writer";
import { applyBackfill } from "./backfill-story-metrics";
import type { RunCompletionOptions } from "./run-completion";

/** The slice of `_runCompletionDeps` the teardown phase calls. */
export interface TeardownDeps {
  closeAllRunSessions: typeof closeAllRunSessions;
}

/** The slice of `_runCompletionDeps` the purge phase calls. */
export interface PurgeDeps {
  purgeStaleManifests: typeof purgeStaleManifests;
}

/**
 * Deferred plugin review consumption (#1146 G2) — run-completion phase 2.
 * The deferred review already ran inside executeUnified; here we make its
 * result observable and, when opted in, gate the run on it. Default mode is
 * observational: failures are surfaced but do NOT change run outcome
 * (preserves ADR-023 D2 behavior).
 */
export function consumeDeferredReview(input: {
  options: RunCompletionOptions;
  config: NaxConfig;
  runId: string;
  logger: Logger | undefined;
}): { pluginGateFailed: boolean } {
  const { options, config, runId, logger } = input;
  let pluginGateFailed = false;
  const deferredReview = options.deferredReview;
  if (deferredReview !== undefined) {
    const findingCount = deferredReview.reviewerResults.filter((r) => !r.passed).length;
    // postrun:phase:started was already emitted in unified-executor.ts before the review ran.
    // Use deferredReviewStartedAt (threaded from the call site) so durationMs reflects the
    // actual review execution time, not the trivial overhead of this emit call.
    const reviewDurationMs = Date.now() - (options.deferredReviewStartedAt ?? Date.now());
    pipelineEventBus.emit({
      type: "postrun:phase:completed",
      phase: "review",
      passed: !deferredReview.anyFailed,
      durationMs: reviewDurationMs,
      details: { findingCount, anyFailed: deferredReview.anyFailed },
    });
  }
  if (deferredReview?.anyFailed) {
    const failedReviewers = deferredReview.reviewerResults.filter((r) => !r.passed).map((r) => r.name);
    pluginGateFailed = config.review.pluginMode === "gating";
    logger?.warn("review", "Deferred plugin reviewer(s) reported failures", {
      storyId: runId,
      failedReviewers,
      pluginMode: config.review.pluginMode,
      gating: pluginGateFailed,
    });
  }
  return { pluginGateFailed };
}

export interface CompletionCosts {
  /** Authoritative run total from the cost aggregator. Use for all downstream reporting. */
  reportedTotal: number;
  /**
   * Carried beside the total, never in place of it: a sum cannot be un-summed,
   * and "spend that produced work" vs "spend that produced nothing" is the
   * distinction any analysis of a failure-heavy run needs. Omitted at zero, so
   * its presence always means dispatches actually failed.
   */
  errorCostField: { errorCostUsd?: number };
  aggByStage: ReturnType<RunCompletionOptions["runtime"]["costAggregator"]["byStage"]>;
  aggByStory: ReturnType<RunCompletionOptions["runtime"]["costAggregator"]["byStory"]>;
}

/**
 * Snapshot the cost aggregator and apply the story-metrics backfill
 * (run-completion phase 3). Mutates `allStoryMetrics` in place, exactly as
 * the original inline block did.
 */
export function snapshotCostsAndBackfill(input: {
  options: RunCompletionOptions;
  config: NaxConfig;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
}): CompletionCosts {
  const { options, config, prd, allStoryMetrics } = input;
  const aggSnap = options.runtime.costAggregator.snapshot();
  // Bug 909 fixed the completion-phase half of "the aggregator captured it and
  // nobody read it". This is the other half: `totalErrorCostUsd` had no consumer
  // anywhere in nax, so spend on dispatches that threw was billed to the user
  // and reported nowhere. What a run cost is both halves.
  const reportedTotal = totalSpendUsd(aggSnap);
  const errorCostUsd = aggSnap.totalErrorCostUsd;
  const errorCostField: { errorCostUsd?: number } = errorCostUsd > 0 ? { errorCostUsd } : {};

  const aggByStage = options.runtime.costAggregator.byStage();
  const aggByStory = options.runtime.costAggregator.byStory();

  // nax#1721: domain, evidence rule and synthesis all live in backfill-story-metrics.ts.
  applyBackfill({
    allStoryMetrics,
    aggByStory,
    stories: prd.userStories,
    agentFallbacks: options.runtime.agentFallbacks,
    runtimeCrashRetries: options.runtime.runtimeCrashRetries,
    config,
    defaultAgent: options.agentManager?.getDefault() ?? resolveDefaultAgent(config),
  });
  return { reportedTotal, errorCostField, aggByStage, aggByStory };
}

/**
 * Session teardown (run-completion phase 4): close every run session, then
 * dispose the per-run plugin-provider cache.
 */
export async function teardownRunSessions(input: { options: RunCompletionOptions; deps: TeardownDeps }): Promise<void> {
  const { options, deps } = input;
  // ADR-020 §D3 makes `sessionManager` and `agentManager` non-nullable on every
  // dispatch context, so the pre-ADR-020 `if (options.sessionManager)` guard and
  // the `agentManager ? … : undefined` ternary this call used to carry were both
  // always taken. Removed with the test that pinned their false branch (#1514).
  //
  // PERF-1: thread the run's abort signal through so a wedged acpx teardown
  // spawn can be cut short externally instead of only relying on the
  // per-call hard deadline inside trackedSpawn.
  await deps.closeAllRunSessions(options.sessionManager, (name: string) => options.agentManager.getAgent(name), {
    signal: options.abortSignal,
  });

  if (options.pluginProviderCache) {
    await options.pluginProviderCache.disposeAll();
  }
}

/**
 * Emit run:completed with real story counts (RL-002) and save the run metrics
 * (run-completion phase 5). Metrics saving is best-effort — disk write errors
 * do not fail the run.
 */
export async function emitRunCompletedAndSaveMetrics(input: {
  options: RunCompletionOptions;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
  durationMs: number;
  runCompletedAt: string;
  reportedTotal: number;
  errorCostField: { errorCostUsd?: number };
  logger: Logger | undefined;
}): Promise<{ finalCounts: ReturnType<typeof countStories> }> {
  const logger = input.logger;
  const { options, prd, allStoryMetrics, durationMs, runCompletedAt, reportedTotal, errorCostField } = input;
  const { runId, feature, startedAt, storiesCompleted } = options;

  // Compute final story counts before emitting completion event (RL-002)
  const finalCounts = countStories(prd);

  // ADR-012 PR-2: aggregate agent-swap cost/hop data for run-level visibility.
  // Undefined when no hops occurred — conditionally spread into both the event
  // and the saved metrics so consumers see the field only when meaningful.
  const fallbackAggregate = deriveRunFallbackAggregates(allStoryMetrics);

  // Emit run:completed after regression gate with real story counts (RL-002)
  pipelineEventBus.emit({
    type: "run:completed",
    totalStories: finalCounts.total,
    passedStories: finalCounts.passed,
    failedStories: finalCounts.failed,
    skippedStories: finalCounts.skipped,
    pausedStories: finalCounts.paused,
    durationMs,
    totalCost: reportedTotal,
    ...errorCostField,
    ...(fallbackAggregate && { fallback: fallbackAggregate }),
  });
  // Drain async subscriber Promises (reporter.onRunEnd file writes, etc.) before
  // proceeding. Without this, run:completed handlers may not finish before caller returns.
  await pipelineEventBus.drain();

  // Save run metrics (best-effort — disk write errors do not fail the run)
  const runMetrics = {
    runId,
    feature,
    startedAt,
    completedAt: runCompletedAt,
    totalCost: reportedTotal,
    ...errorCostField,
    totalStories: allStoryMetrics.length,
    storiesCompleted,
    storiesFailed: finalCounts.failed,
    totalDurationMs: durationMs,
    stories: allStoryMetrics,
    ...(fallbackAggregate && { fallback: fallbackAggregate }),
  };

  try {
    await saveRunMetrics(options.runtime.outputDir, runMetrics);
  } catch (err) {
    logger?.warn("run.complete", "Failed to save run metrics", { error: String(err) });
  }

  return { finalCounts };
}

/**
 * Purge stale session scratch dirs (AC-20) and stale context manifests
 * (US-002) — run-completion phase 6. Both are fail-open: a rejection is
 * logged at warn level and completion continues normally.
 */
export async function purgeStaleRunArtifacts(input: {
  options: RunCompletionOptions;
  prd: PRD;
  config: NaxConfig;
  workdir: string;
  feature: string;
  logger: Logger | undefined;
  deps: PurgeDeps;
}): Promise<void> {
  const logger = input.logger;
  const { options, prd, config, workdir, feature, deps } = input;

  // AC-20: purge stale session scratch dirs
  const effectiveProjectDir = options.projectDir ?? workdir;
  const sessionCfg = config.context?.v2?.session;
  if (sessionCfg?.retentionDays) {
    const featureComplete = isComplete(prd);
    const archiveInsteadOfDelete = sessionCfg.archiveOnFeatureArchive && featureComplete;
    try {
      const purged = await purgeStaleScratch(
        effectiveProjectDir,
        feature,
        sessionCfg.retentionDays,
        archiveInsteadOfDelete,
      );
      if (purged > 0) {
        logger?.info("run.complete", "Purged stale session scratch dirs", { feature, purged });
      }
    } catch (err) {
      logger?.warn("run.complete", "Failed to purge stale session scratch", { error: String(err) });
    }
  }

  // US-002: purge stale context manifests (opt-in via context.v2.manifest.retentionDays).
  // Fail-open: a rejection is logged at warn level and completion continues normally.
  const manifestCfg = config.context?.v2?.manifest;
  if (manifestCfg?.retentionDays) {
    try {
      const purged = await deps.purgeStaleManifests(effectiveProjectDir, manifestCfg.retentionDays);
      if (purged > 0) {
        logger?.info("run.complete", "Purged stale context manifests", { purged });
      }
    } catch (err) {
      logger?.warn("run.complete", "Failed to purge stale context manifests", { error: String(err) });
    }
  }
}

/**
 * The completion summary log (run-completion phase 7): per-story metrics,
 * AC-25 context cost, and the aggregator's per-stage/per-story splits.
 */
export function logRunCompletion(input: {
  options: RunCompletionOptions;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
  finalCounts: ReturnType<typeof countStories>;
  reportedTotal: number;
  errorCostField: { errorCostUsd?: number };
  aggByStage: CompletionCosts["aggByStage"];
  aggByStory: CompletionCosts["aggByStory"];
  durationMs: number;
  logger: Logger | undefined;
}): void {
  const logger = input.logger;
  const {
    options,
    prd,
    allStoryMetrics,
    finalCounts,
    reportedTotal,
    errorCostField,
    aggByStage,
    aggByStory,
    durationMs,
  } = input;
  const { runId, feature, iterations, storiesCompleted } = options;

  // Log run completion

  // Prepare per-story metrics summary
  const storyMetricsSummary = allStoryMetrics.map((sm) => ({
    storyId: sm.storyId,
    complexity: sm.complexity,
    modelTier: sm.modelTier,
    modelUsed: sm.modelUsed,
    attempts: sm.attempts,
    finalTier: sm.finalTier,
    success: sm.success,
    cost: sm.cost,
    durationMs: sm.durationMs,
    firstPassSuccess: sm.firstPassSuccess,
  }));

  // AC-25: sum context provider cost across all stories
  const contextCostUsd = allStoryMetrics.reduce((runSum, sm) => {
    if (!sm.context?.providers) return runSum;
    return runSum + Object.values(sm.context.providers).reduce((s, p) => s + (p.costUsd ?? 0), 0);
  }, 0);

  logger?.info("run.complete", "Feature execution completed", {
    runId,
    feature,
    success: isComplete(prd),
    iterations,
    totalStories: finalCounts.total,
    storiesCompleted,
    storiesFailed: finalCounts.failed,
    storiesPending: finalCounts.pending,
    totalCost: reportedTotal,
    ...errorCostField,
    ...(contextCostUsd > 0 && { contextCostUsd }),
    ...(Object.keys(aggByStage).length > 0 && { costByStage: aggByStage }),
    ...(Object.keys(aggByStory).length > 0 && { costByStory: aggByStory }),
    durationMs,
    storyMetrics: storyMetricsSummary,
  });
}

/**
 * Write the final run status (run-completion phase 8): the PRD, the cleared
 * current story, the terminal run status, and the status.json update.
 */
export async function writeFinalStatus(input: {
  options: RunCompletionOptions;
  prd: PRD;
  statusWriter: StatusWriter;
  config: NaxConfig;
  regressionGateFailed: boolean;
  reportedTotal: number;
  iterations: number;
}): Promise<void> {
  const { options, prd, statusWriter, config, regressionGateFailed, reportedTotal, iterations } = input;
  const { exitReason } = options;

  // Update final status
  statusWriter.setPrd(prd);
  statusWriter.setCurrentStory(null);
  statusWriter.setRunStatus(
    regressionGateFailed
      ? "failed"
      : exitReason === "cost-limit"
        ? "cost-limit"
        : isComplete(prd)
          ? "completed"
          : isStalled(prd, config.execution.rectification?.maxAttemptsTotal)
            ? "stalled"
            : // The run has stopped (this is the completion phase) with stories
              // still pending but not stalled — e.g. exitReason "pre-merge-aborted",
              // "max-iterations", "no-stories". "running" would leave status.json
              // claiming the (now-dead) PID is still live (EXEC-1).
              "aborted",
  );
  await statusWriter.update(reportedTotal, iterations);
}
