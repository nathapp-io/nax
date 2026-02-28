/**
 * Parallel Execution Lifecycle
 *
 * Handles metrics saving and reporter notifications for parallel execution completion.
 * Extracted from runner.ts to reduce its size.
 */

import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import { saveRunMetrics } from "../../metrics";
import type { PluginRegistry } from "../../plugins/registry";
import { countStories } from "../../prd";
import type { PRD } from "../../prd";

export interface ParallelCompletionOptions {
  runId: string;
  feature: string;
  startedAt: string;
  completedAt: string;
  prd: PRD;
  allStoryMetrics: StoryMetrics[];
  totalCost: number;
  storiesCompleted: number;
  durationMs: number;
  workdir: string;
  pluginRegistry: PluginRegistry;
}

/**
 * Handle parallel execution completion:
 * - Save run metrics
 * - Emit reporter events
 */
export async function handleParallelCompletion(options: ParallelCompletionOptions): Promise<void> {
  const logger = getSafeLogger();
  const {
    runId,
    feature,
    startedAt,
    completedAt,
    prd,
    allStoryMetrics,
    totalCost,
    storiesCompleted,
    durationMs,
    workdir,
    pluginRegistry,
  } = options;

  // Save run metrics
  const runMetrics = {
    runId,
    feature,
    startedAt,
    completedAt,
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
  logger?.info("run.complete", "Feature execution completed", {
    runId,
    feature,
    success: true,
    totalStories: finalCounts.total,
    storiesCompleted,
    storiesFailed: finalCounts.failed,
    storiesPending: finalCounts.pending,
    totalCost,
    durationMs,
  });

  // Emit onRunEnd to reporters
  const reporters = pluginRegistry.getReporters();
  for (const reporter of reporters) {
    if (reporter.onRunEnd) {
      try {
        await reporter.onRunEnd({
          runId,
          totalDurationMs: durationMs,
          totalCost,
          storySummary: {
            completed: storiesCompleted,
            failed: finalCounts.failed,
            skipped: finalCounts.skipped,
            paused: finalCounts.paused,
          },
        });
      } catch (error) {
        logger?.warn("plugins", `Reporter '${reporter.name}' onRunEnd failed`, { error });
      }
    }
  }
}
