/**
 * Run Completion — Final Metrics and Status Updates
 *
 * Handles the final steps after sequential execution completes:
 * - Run deferred regression gate (if configured)
 * - Save run metrics
 * - Log completion summary with per-story metrics
 * - Update final status
 */

import { resolveDefaultAgent } from "../../agents";
import type { IAgentManager } from "../../agents";
import { clearLanguageCache } from "../../project/detector";
import { clearWorkspaceCache } from "../../test-runners/detect/workspace";
import type { NaxConfig } from "../../config";
import { fireHook } from "../../hooks/runner";
import type { HooksConfig } from "../../hooks/types";
import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import { deriveRunFallbackAggregates, saveRunMetrics } from "../../metrics";
import { pipelineEventBus } from "../../pipeline/event-bus";
import { countStories, isComplete, isStalled } from "../../prd";
import type { PRD } from "../../prd";
import type { DispatchContext } from "../../runtime/dispatch-context";
import type { ISessionManager } from "../../session";
import { purgeStaleScratch } from "../../session/scratch-purge";
import type { DeferredReviewResult } from "../deferred-review";
import { closeAllRunSessions } from "../session-manager-runtime";
import type { StatusWriter } from "../status-writer";
import { runDeferredRegression } from "./run-regression";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runCompletionDeps = {
  runDeferredRegression,
  fireHook,
  closeAllRunSessions,
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
  pluginProviderCache?: import("../../context/engine").PluginProviderCache;
  /**
   * Result of the end-of-run deferred plugin review (#1146 G2). Undefined when no
   * IReviewPlugin reviewers are registered. Consumed here: always surfaced; gates
   * the run only when config.review.pluginMode === "gating".
   */
  deferredReview?: DeferredReviewResult;
}

export interface RunCompletionResult {
  durationMs: number;
  runCompletedAt: string;
  /**
   * Authoritative run total — max of the legacy per-iteration accumulator and
   * the cost aggregator snapshot. Callers MUST use this for downstream reporting
   * (exit summary, headless footer, feature-status file) instead of the stale
   * `options.totalCost`, which only covers execution-phase work and silently
   * drops acceptance/review/diagnosis spend (issue #909).
   */
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
    totalCost,
    storiesCompleted,
    iterations,
    startTime,
    workdir,
    statusWriter,
    config,
    hooksConfig,
  } = options;

  // Run deferred regression gate before final metrics
  const regressionMode = config.execution.regressionGate?.mode;
  if (options.skipRegression) {
    // Regression phase already passed on a prior run — skip
  } else if (regressionMode === "deferred" && config.quality.commands.test) {
    statusWriter.setPostRunPhase("regression", { status: "running" });

    const regressionResult = await _runCompletionDeps.runDeferredRegression({
      config,
      prd,
      workdir,
      runtime: options.runtime,
    });

    const lastRunAt = new Date().toISOString();

    logger?.info("regression", "Deferred regression gate completed", {
      success: regressionResult.success,
      failedTests: regressionResult.failedTests,
      affectedStories: regressionResult.affectedStories,
    });

    if (regressionResult.success) {
      statusWriter.setPostRunPhase("regression", { status: "passed", lastRunAt });
    } else {
      statusWriter.setPostRunPhase("regression", {
        status: "failed",
        failedTests: regressionResult.failedTestFiles,
        affectedStories: regressionResult.affectedStories,
        lastRunAt,
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
        }
      }
      // Reflect regression gate failure in run status (RL-004)
      statusWriter.setRunStatus("failed");

      if (hooksConfig) {
        await _runCompletionDeps.fireHook(
          hooksConfig as import("../../hooks/runner").LoadedHooksConfig,
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

  // Bug 909 fix — consult the cost aggregator for the authoritative spend total.
  // Every agent call dispatched through AgentManager emits a DispatchEvent with cost,
  // captured by attachCostSubscriber into runtime.costAggregator. The legacy `totalCost`
  // only counts execution-phase work and silently drops acceptance/hardening/diagnosis spend.
  const aggSnap = options.runtime.costAggregator.snapshot();
  const aggregatorTotal = aggSnap.totalCostUsd;
  const reportedTotal = Math.max(totalCost, aggregatorTotal);

  if (aggregatorTotal > totalCost + 0.01) {
    logger?.debug("run.complete", "Cost aggregator total exceeds accumulated totalCost", {
      totalCost,
      aggregatorTotal,
      gap: aggregatorTotal - totalCost,
    });
  }

  const aggByStage = options.runtime.costAggregator.byStage();
  const aggByStory = options.runtime.costAggregator.byStory();

  // Back-fill storyMetrics for stories whose only spend was in the completion phase
  // (acceptance refinement, hardening, diagnosis, fix-cycle). These stories have cost
  // in the aggregator but no entry in allStoryMetrics from the execution phase.
  {
    const existingIndex = new Map(allStoryMetrics.map((m, i) => [m.storyId, i]));
    const completionCompletedAt = new Date().toISOString();
    const defaultAgent = options.agentManager?.getDefault() ?? resolveDefaultAgent(config);

    for (const [storyId, snap] of Object.entries(aggByStory)) {
      if (snap.totalCostUsd <= 0) continue;
      const existingIdx = existingIndex.get(storyId);
      if (existingIdx === undefined) {
        const story = prd.userStories.find((s) => s.id === storyId);
        allStoryMetrics.push({
          storyId,
          complexity: story?.routing?.complexity ?? "medium",
          modelTier: "balanced",
          modelUsed: defaultAgent,
          attempts: 0,
          finalTier: "balanced",
          success: story?.passes ?? true,
          cost: snap.totalCostUsd,
          durationMs: 0,
          firstPassSuccess: story?.passes ?? true,
          startedAt: completionCompletedAt,
          completedAt: completionCompletedAt,
          source: "completion-phase" as const,
          runtimeCrashes: 0,
        });
      } else {
        // Story already has an execution-phase entry — replace cost with the aggregator
        // value if it's higher (aggregator is authoritative across all phases).
        const existing = allStoryMetrics[existingIdx];
        if (snap.totalCostUsd > (existing.cost ?? 0)) {
          allStoryMetrics[existingIdx] = { ...existing, cost: snap.totalCostUsd };
        }
      }
    }
  }

  const durationMs = Date.now() - startTime;
  const runCompletedAt = new Date().toISOString();

  if (options.sessionManager) {
    const agentGetFn = options.agentManager ? (name: string) => options.agentManager?.getAgent(name) : undefined;
    await _runCompletionDeps.closeAllRunSessions(options.sessionManager, agentGetFn);
  }

  if (options.pluginProviderCache) {
    await options.pluginProviderCache.disposeAll();
  }

  // Clear per-run detection memos so subsequent runs in the same process start fresh.
  clearLanguageCache();
  clearWorkspaceCache();

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
  statusWriter.setRunStatus(isComplete(prd) ? "completed" : isStalled(prd) ? "stalled" : "running");
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
