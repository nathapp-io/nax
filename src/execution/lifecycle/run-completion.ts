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
}

export interface RunCompletionResult {
  durationMs: number;
  runCompletedAt: string;
  finalCounts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    pending: number;
  };
}

/**
 * Check if deferred regression should be skipped (RL-006).
 *
 * Smart-skip applies when:
 * 1. All stories have fullSuiteGatePassed === true
 * 2. Execution is sequential (or defaults to sequential when not specified)
 * 3. There is at least one story metric
 */
function shouldSkipDeferredRegression(allStoryMetrics: StoryMetrics[], isSequential: boolean | undefined): boolean {
  // Default to sequential mode
  const effectiveSequential = isSequential !== false;

  // Must be sequential mode
  if (!effectiveSequential) {
    return false;
  }

  // Must have at least one story metric
  if (allStoryMetrics.length === 0) {
    return false;
  }

  // All stories must have fullSuiteGatePassed === true
  return allStoryMetrics.every((m) => m.fullSuiteGatePassed === true);
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
    isSequential,
  } = options;

  // Run deferred regression gate before final metrics
  const regressionMode = config.execution.regressionGate?.mode;
  if (options.skipRegression) {
    // Regression phase already passed on a prior run — skip
  } else if (regressionMode === "deferred" && config.quality.commands.test) {
    if (shouldSkipDeferredRegression(allStoryMetrics, isSequential)) {
      logger?.info(
        "regression",
        "Smart-skip: skipping deferred regression (all stories passed full-suite gate in sequential mode)",
      );
      statusWriter.setPostRunPhase("regression", {
        status: "passed",
        skipped: true,
        lastRunAt: new Date().toISOString(),
      });
    } else {
      statusWriter.setPostRunPhase("regression", { status: "running" });

      const regressionResult = await _runCompletionDeps.runDeferredRegression({
        config,
        prd,
        workdir,
        agentManager: options.agentManager,
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
    totalCost,
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
    totalCost,
    totalStories: allStoryMetrics.length,
    storiesCompleted,
    storiesFailed: finalCounts.failed,
    totalDurationMs: durationMs,
    stories: allStoryMetrics,
    ...(fallbackAggregate && { fallback: fallbackAggregate }),
  };

  try {
    await saveRunMetrics(workdir, runMetrics);
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
    totalCost,
    ...(contextCostUsd > 0 && { contextCostUsd }),
    durationMs,
    storyMetrics: storyMetricsSummary,
  });

  // Update final status
  statusWriter.setPrd(prd);
  statusWriter.setCurrentStory(null);
  statusWriter.setRunStatus(isComplete(prd) ? "completed" : isStalled(prd) ? "stalled" : "running");
  await statusWriter.update(totalCost, iterations);

  return {
    durationMs,
    runCompletedAt,
    finalCounts: {
      total: finalCounts.total,
      passed: finalCounts.passed,
      failed: finalCounts.failed,
      skipped: finalCounts.skipped,
      pending: finalCounts.pending,
    },
  };
}
