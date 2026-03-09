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
import { fireHook } from "../../hooks/runner";
import type { HooksConfig } from "../../hooks/types";
import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import { saveRunMetrics } from "../../metrics";
import { pipelineEventBus } from "../../pipeline/event-bus";
import { countStories, isComplete, isStalled } from "../../prd";
import type { PRD } from "../../prd";
import type { StatusWriter } from "../status-writer";
import { runDeferredRegression } from "./run-regression";

/**
 * Injectable dependencies for testing (avoids mock.module() which leaks in Bun 1.x).
 * @internal - test use only.
 */
export const _runCompletionDeps = {
  runDeferredRegression,
  fireHook,
};

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
  hooksConfig?: HooksConfig;
  /** Whether the run used sequential (non-parallel) execution. Defaults to true. */
  isSequential?: boolean;
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
    hooksConfig,
  } = options;

  // Run deferred regression gate before final metrics
  const regressionMode = config.execution.regressionGate?.mode;
  if (regressionMode === "deferred" && config.quality.commands.test) {
    const regressionResult = await _runCompletionDeps.runDeferredRegression({
      config,
      prd,
      workdir,
    });

    logger?.info("regression", "Deferred regression gate completed", {
      success: regressionResult.success,
      failedTests: regressionResult.failedTests,
      affectedStories: regressionResult.affectedStories,
    });

    if (!regressionResult.success) {
      // Mark affected stories as regression-failed (RL-004)
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
  }

  const durationMs = Date.now() - startTime;
  const runCompletedAt = new Date().toISOString();

  // Compute final story counts before emitting completion event (RL-002)
  const finalCounts = countStories(prd);

  // Emit run:completed after regression gate with real story counts (RL-002)
  pipelineEventBus.emit({
    type: "run:completed",
    totalStories: finalCounts.total,
    passedStories: finalCounts.passed,
    failedStories: finalCounts.failed,
    durationMs,
    totalCost,
  });

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
  };

  try {
    await saveRunMetrics(workdir, runMetrics);
  } catch (err) {
    logger?.warn("run.complete", "Failed to save run metrics", { error: String(err) });
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
