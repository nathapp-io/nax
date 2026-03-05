/**
 * Run Completion — Final Metrics and Status Updates
 *
 * Handles the final steps after sequential execution completes:
 * - Run deferred regression gate (if configured)
 * - Save run metrics
 * - Log completion summary with per-story metrics
 * - Update final status
 */

import type { NaxConfig } from "../../config";
import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import { saveRunMetrics } from "../../metrics";
import { countStories, isComplete, isStalled } from "../../prd";
import type { PRD } from "../../prd";
import type { StatusWriter } from "../status-writer";

export interface RunCompletionOptions {
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
  } = options;

  // Run deferred regression gate before final metrics
  const regressionMode = config.execution.regressionGate?.mode ?? "deferred";
  if (regressionMode === "deferred" && config.quality.commands.test) {
    const { runDeferredRegression } = await import("./run-regression");
    const regressionResult = await runDeferredRegression({
      config,
      prd,
      workdir,
    });

    logger?.info("regression", "Deferred regression gate completed", {
      success: regressionResult.success,
      failedTests: regressionResult.failedTests,
      affectedStories: regressionResult.affectedStories,
    });
  }

  const durationMs = Date.now() - startTime;
  const runCompletedAt = new Date().toISOString();

  // Save run metrics
  const runMetrics = {
    runId,
    feature,
    startedAt,
    completedAt: runCompletedAt,
    totalCost,
    totalStories: allStoryMetrics.length,
    storiesCompleted,
    storiesFailed: countStories(prd).failed,
    totalDurationMs: durationMs,
    stories: allStoryMetrics,
  };

  await saveRunMetrics(workdir, runMetrics);

  // Log run completion
  const finalCounts = countStories(prd);

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
