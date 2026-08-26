/**
 * Run Completion — Final Metrics and Status Updates
 *
 * Handles the final steps after sequential execution completes:
 * - Run deferred regression gate (if configured)
 * - Save run metrics
 * - Log completion summary with per-story metrics
 * - Update final status
 */

import { resolveDefaultAgent } from "@/agents";
import type { NaxConfig } from "@/config";
import { _resetCanonicalRulesCache, purgeStaleManifests } from "@/context/engine";
import { fireHook } from "@/hooks";
import type { HooksConfig } from "@/hooks/types";
import { getSafeLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import { deriveRunFallbackAggregates, saveRunMetrics } from "@/metrics";
import { pipelineEventBus } from "@/pipeline";
import type { PRD } from "@/prd";
import { countStories, isComplete, isStalled } from "@/prd";
import { clearLanguageCache } from "@/project";
import type { DispatchContext } from "@/runtime/dispatch-context";
import { purgeStaleScratch } from "@/session";
import { clearWorkspaceCache } from "@/test-runners/detect";
import { clearGitRootCache } from "@/verification";
import type { DeferredReviewResult } from "../deferred-review";
import type { ExitReason } from "../executor-types";
import { closeAllRunSessions } from "../session-manager-runtime";
import type { StatusWriter } from "../status-writer";
import { applyBackfill } from "./backfill-story-metrics";
import { runDeferredRegression } from "./run-regression";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runCompletionDeps = {
  runDeferredRegression,
  fireHook,
  closeAllRunSessions,
  purgeStaleManifests,
};

export interface RunCompletionOptions extends DispatchContext {
  runId: string;
  feature: string;
  startedAt: string;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
  totalCost: number;
  storiesCompleted: number;
  iterations: number;
  startTime: number;
  workdir: string;
  statusWriter: StatusWriter;
  config: NaxConfig;
  hooksConfig?: HooksConfig;
  /** Whether the run used sequential (non-parallel) execution. Defaults to true. */
  isSequential?: boolean;
  /** Skip deferred regression gate — set when regression phase already passed on a prior run. */
  skipRegression?: boolean;
  /**
   * Absolute path to the project root (where .nax/ lives).
   * Defaults to workdir when absent (non-monorepo).
   * Used for session scratch purge (AC-20).
   */
  projectDir?: string;
  /** Per-run plugin-provider cache (Finding 5 / issue #473). Disposed after session teardown. */
  pluginProviderCache?: import("@/context/engine").PluginProviderCache;
  /**
   * Result of the end-of-run deferred plugin review (#1146 G2). Undefined when no
   * IReviewPlugin reviewers are registered. Consumed here: always surfaced; gates
   * the run only when config.review.pluginMode === "gating".
   */
  deferredReview?: DeferredReviewResult;
  /**
   * Timestamp (from Date.now()) when postrun:phase:started was emitted for the review phase.
   * Emitted in unified-executor.ts before the review ran; threaded here so handleRunCompletion
   * can compute accurate durationMs for the postrun:phase:completed event (AC9).
   */
  deferredReviewStartedAt?: number;
  /** Why the execution phase stopped — used to distinguish a cost-limit stop from a normal completion. */
  exitReason?: ExitReason;
}

export interface RunCompletionResult {
  durationMs: number;
  runCompletedAt: string;
  /** Authoritative run total from the cost aggregator. Use for all downstream reporting. */
  reportedTotal: number;
  finalCounts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
  };
  /**
   * True when config.review.pluginMode === "gating" AND a deferred plugin reviewer
   * failed. Propagated up to runner.ts to fail RunResult.success. Always false in
   * observational mode (#1146 G2).
   */
  pluginGateFailed: boolean;
}

/**
 * Handle final run completion: save metrics, log summary, update status
 */
export async function handleRunCompletion(options: RunCompletionOptions): Promise<RunCompletionResult> {
  const logger = getSafeLogger();
  const {
    runId,
    feature,
    startedAt,
    prd,
    allStoryMetrics,
    storiesCompleted,
    iterations,
    startTime,
    workdir,
    statusWriter,
    config,
    hooksConfig,
    exitReason,
  } = options;

  // Run deferred regression gate before final metrics
  // Tracked separately from the setRunStatus("failed") call below (line ~188) so a
  // cost-limit exit can never mask a genuine regression-gate failure — see the final
  // classification at the end of this function.
  let regressionGateFailed = false;
  const regressionMode = config.execution.regressionGate?.mode;
  if (options.skipRegression) {
    // Regression phase already passed on a prior run — skip
  } else if (
    // 'per-story' is a superset of 'deferred': the per-story full-suite gate runs
    // during the main loop AND the deferred regression runs once at end-of-run.
    (regressionMode === "deferred" || regressionMode === "per-story") &&
    config.quality.commands.test
  ) {
    statusWriter.setPostRunPhase("regression", { status: "running" });
    const regressionStartTime = Date.now();
    pipelineEventBus.emit({ type: "postrun:phase:started", phase: "regression" });

    let regressionResult: Awaited<ReturnType<typeof _runCompletionDeps.runDeferredRegression>>;
    try {
      regressionResult = await _runCompletionDeps.runDeferredRegression({
        config,
        prd,
        workdir,
        runtime: options.runtime,
        // Shared with the per-story full-suite gate (via the story-orchestrator's
        // triage seam) so a test quarantined earlier in the run is relabeled here
        // without a second probe.
        quarantineMemo: options.runtime.quarantineMemo,
        // Per-story gate snapshots enable causal blame attribution (transition
        // pass -> fail). Sequential runs only: in parallel mode story completion
        // order (`completedAt`) is not causal and each story runs in an isolated
        // worktree, so a per-story snapshot does not reflect merged-repo state.
        //
        // Withholding them in parallel used to mean "fall back to the git-recency
        // heuristic". #1527 deleted that heuristic — blaming whichever story
        // committed most recently is not evidence — so withholding now means the
        // gate reports the regression and rectifies nothing. That is deliberate:
        // a parallel regression needs a human, not a guess. `isSequential` was
        // never forwarded from the runner until #1528's follow-up, so this branch
        // was dead and parallel runs were attributing from non-causal snapshots.
        storyMetrics:
          options.isSequential === false
            ? undefined
            : allStoryMetrics.map((m) => ({
                storyId: m.storyId,
                completedAt: m.completedAt,
                failingTestFiles: m.failingTestFiles,
              })),
      });
    } catch (err) {
      // A thrown error here would otherwise leave "regression" permanently
      // "running" in the TUI/status.json — no postrun:phase:completed ever
      // fires (post-impl-review quality finding).
      pipelineEventBus.emit({
        type: "postrun:phase:completed",
        phase: "regression",
        passed: false,
        durationMs: Date.now() - regressionStartTime,
      });
      throw err;
    }

    const lastRunAt = new Date().toISOString();

    logger?.info("regression", "Deferred regression gate completed", {
      success: regressionResult.success,
      failedTests: regressionResult.failedTests,
      affectedStories: regressionResult.affectedStories,
    });

    const regressionDurationMs = Date.now() - regressionStartTime;
    if (regressionResult.success) {
      statusWriter.setPostRunPhase("regression", { status: "passed", lastRunAt });
      pipelineEventBus.emit({
        type: "postrun:phase:completed",
        phase: "regression",
        passed: true,
        durationMs: regressionDurationMs,
        details: { mode: regressionMode, failedTests: 0 },
      });
    } else {
      statusWriter.setPostRunPhase("regression", {
        status: "failed",
        failedTests: regressionResult.failedTestFiles,
        affectedStories: regressionResult.affectedStories,
        lastRunAt,
      });
      pipelineEventBus.emit({
        type: "postrun:phase:completed",
        phase: "regression",
        passed: false,
        durationMs: regressionDurationMs,
        details: {
          mode: regressionMode,
          failedTests: regressionResult.failedTests,
        },
      });

      // Mark affected stories as regression-failed in-memory for current-run event counts (RL-004).
      // Intentionally NOT saved to prd.json — rerun resume is driven by status.json via
      // setPostRunPhase("regression", { status: "failed" }) above. On rerun, runner-completion.ts
      // reads getPostRunStatus().regression.status from status.json and re-runs the regression
      // phase when it is not "passed". Saving this to prd.json is unnecessary and would require
      // prdPath to be threaded into handleRunCompletion. See PR #254 / issue #250.
      for (const storyId of regressionResult.affectedStories) {
        const story = prd.userStories.find((s) => s.id === storyId);
        if (story) {
          story.status = "regression-failed";
          // isComplete() checks `s.passes || s.status === "passed" || ...` — the `passes`
          // clause short-circuits before status, so it must be reset here too or a
          // regression-failed story still reads as complete (issue #1292).
          story.passes = false;
        }
      }
      // Reflect regression gate failure in run status (RL-004)
      statusWriter.setRunStatus("failed");
      regressionGateFailed = true;

      if (hooksConfig) {
        await _runCompletionDeps.fireHook(
          hooksConfig as import("@/hooks").LoadedHooksConfig,
          "on-final-regression-fail",
          {
            event: "on-final-regression-fail",
            feature,
            status: "failed",
            failedTests: regressionResult.failedTests,
            affectedStories: regressionResult.affectedStories,
          },
          workdir,
        );
      }
    }

    // Back-fill or merge storyMetrics for stories rectified by the regression gate (issue #679).
    // Two cases:
    //   1. Story has no existing entry (prior run-resume or earlier execution batch): inject a
    //      synthetic "rectification" entry so cost and outcome show up in run.complete analytics.
    //   2. Story already has an entry (normal execution loop + regression-gate rectification in
    //      the same run): fold the rectification cost + duration into the existing entry so the
    //      regression-gate effort isn't silently dropped.
    const regressionStoryCosts = regressionResult.storyCosts ?? {};
    const regressionStoryDurations = regressionResult.storyDurations ?? {};
    const regressionStoryOutcomes = regressionResult.storyOutcomes ?? {};
    if (Object.keys(regressionStoryCosts).length > 0) {
      const existingIndex = new Map(allStoryMetrics.map((m, i) => [m.storyId, i]));
      const rectCompletedAt = new Date().toISOString();
      const defaultAgent = options.agentManager?.getDefault() ?? resolveDefaultAgent(config);
      for (const [storyId, storyCost] of Object.entries(regressionStoryCosts)) {
        const storyDuration = regressionStoryDurations[storyId] ?? 0;
        // Per-story outcome; fall back to the overall regression result only when missing
        // (e.g. older mocks emit storyCosts without storyOutcomes).
        const storySuccess = regressionStoryOutcomes[storyId] ?? regressionResult.success;
        const existingIdx = existingIndex.get(storyId);
        if (existingIdx === undefined) {
          const regrStory = prd.userStories.find((s) => s.id === storyId);
          allStoryMetrics.push({
            storyId,
            complexity: regrStory?.routing?.complexity ?? "medium",
            modelTier: "balanced",
            modelUsed: defaultAgent,
            attempts: 1,
            finalTier: "balanced",
            success: storySuccess,
            cost: storyCost,
            durationMs: storyDuration,
            firstPassSuccess: false,
            startedAt: rectCompletedAt,
            completedAt: rectCompletedAt,
            source: "rectification" as const,
            rectificationCost: storyCost,
            fullSuiteGatePassed: false,
            runtimeCrashes: 0,
          });
        } else {
          const existing = allStoryMetrics[existingIdx];
          allStoryMetrics[existingIdx] = {
            ...existing,
            cost: existing.cost + storyCost,
            durationMs: existing.durationMs + storyDuration,
            rectificationCost: (existing.rectificationCost ?? 0) + storyCost,
            // A story that needed regression-gate rectification was not a clean first pass.
            firstPassSuccess: false,
            // Preserve the normal-loop success flag unless the regression attempt actually failed.
            success: existing.success && storySuccess,
          };
        }
      }
    }
  }

  // Deferred plugin review consumption (#1146 G2).
  // The deferred review already ran inside executeUnified; here we make its result
  // observable and, when opted in, gate the run on it. Default mode is observational:
  // failures are surfaced but do NOT change run outcome (preserves ADR-023 D2 behavior).
  // NB: do NOT call setRunStatus here — see Defect 2. Run outcome flows via the
  // returned pluginGateFailed flag, which runner-completion.ts folds into finalStatus.
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

  const aggSnap = options.runtime.costAggregator.snapshot();
  const reportedTotal = aggSnap.totalCostUsd;

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

  const durationMs = Date.now() - startTime;
  const runCompletedAt = new Date().toISOString();

  // ADR-020 §D3 makes `sessionManager` and `agentManager` non-nullable on every
  // dispatch context, so the pre-ADR-020 `if (options.sessionManager)` guard and
  // the `agentManager ? … : undefined` ternary this call used to carry were both
  // always taken. Removed with the test that pinned their false branch (#1514).
  //
  // PERF-1: thread the run's abort signal through so a wedged acpx teardown
  // spawn can be cut short externally instead of only relying on the
  // per-call hard deadline inside trackedSpawn.
  await _runCompletionDeps.closeAllRunSessions(
    options.sessionManager,
    (name: string) => options.agentManager.getAgent(name),
    { signal: options.abortSignal },
  );

  if (options.pluginProviderCache) {
    await options.pluginProviderCache.disposeAll();
  }

  // Clear per-run detection memos so subsequent runs in the same process start fresh.
  clearLanguageCache();
  clearWorkspaceCache();
  clearGitRootCache();
  // CTX-2: canonical-rules memoization joins the same per-run-cache-clear
  // convention as the caches above — without this, a long-lived in-process
  // consumer (embedded TUI, watch mode) would keep serving the first run's
  // .nax/rules/ content to every subsequent run in the same process.
  _resetCanonicalRulesCache();

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
      const purged = await _runCompletionDeps.purgeStaleManifests(effectiveProjectDir, manifestCfg.retentionDays);
      if (purged > 0) {
        logger?.info("run.complete", "Purged stale context manifests", { purged });
      }
    } catch (err) {
      logger?.warn("run.complete", "Failed to purge stale context manifests", { error: String(err) });
    }
  }

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
    ...(contextCostUsd > 0 && { contextCostUsd }),
    ...(Object.keys(aggByStage).length > 0 && { costByStage: aggByStage }),
    ...(Object.keys(aggByStory).length > 0 && { costByStory: aggByStory }),
    durationMs,
    storyMetrics: storyMetricsSummary,
  });

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

  return {
    durationMs,
    runCompletedAt,
    reportedTotal,
    finalCounts: {
      total: finalCounts.total,
      passed: finalCounts.passed,
      failed: finalCounts.failed,
      skipped: finalCounts.skipped,
      pending: finalCounts.pending,
    },
    pluginGateFailed,
  };
}
