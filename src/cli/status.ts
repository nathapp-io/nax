/**
 * Status CLI Command
 *
 * Display cost metrics and run statistics.
 */

import { getLogger } from "../logger";
import { calculateAggregateMetrics, getLastRun, loadRunMetrics } from "../metrics";

/**
 * Display aggregate cost metrics across all runs.
 *
 * @param workdir - Project root directory
 *
 * @example
 * ```bash
 * nax status --cost
 * ```
 */
export async function displayCostMetrics(workdir: string): Promise<void> {
  const logger = getLogger();
  const runs = await loadRunMetrics(workdir);

  if (runs.length === 0) {
    logger.info("cli", "No metrics data available yet", { hint: "Run nax run to generate metrics" });
    return;
  }

  const aggregate = calculateAggregateMetrics(runs);

  logger.info("cli", "Cost Metrics (All Runs)", {
    totalRuns: aggregate.totalRuns,
    totalStories: aggregate.totalStories,
    totalCost: aggregate.totalCost,
    avgCostPerStory: aggregate.avgCostPerStory,
    avgCostPerFeature: aggregate.avgCostPerFeature,
    firstPassRate: aggregate.firstPassRate,
    escalationRate: aggregate.escalationRate,
  });
}

/**
 * Display metrics from the most recent run.
 *
 * @param workdir - Project root directory
 *
 * @example
 * ```bash
 * nax status --cost --last
 * ```
 */
export async function displayLastRunMetrics(workdir: string): Promise<void> {
  const logger = getLogger();
  const runs = await loadRunMetrics(workdir);

  if (runs.length === 0) {
    logger.info("cli", "No metrics data available yet", { hint: "Run nax run to generate metrics" });
    return;
  }

  const lastRun = getLastRun(runs);
  if (!lastRun) {
    return;
  }

  logger.info("cli", `Last Run: ${lastRun.feature}`, {
    runId: lastRun.runId,
    startedAt: lastRun.startedAt,
    completedAt: lastRun.completedAt,
    durationMs: lastRun.totalDurationMs,
    totalStories: lastRun.totalStories,
    storiesCompleted: lastRun.storiesCompleted,
    storiesFailed: lastRun.storiesFailed,
    totalCost: lastRun.totalCost,
    avgCostPerStory: lastRun.totalCost / lastRun.totalStories,
  });

  // Show top 5 most expensive stories
  const sortedStories = [...lastRun.stories].sort((a, b) => b.cost - a.cost);
  const topStories = sortedStories.slice(0, 5);

  if (topStories.length > 0) {
    logger.info("cli", "Top 5 Most Expensive Stories", {
      stories: topStories.map((s) => ({
        storyId: s.storyId,
        cost: s.cost,
        model: s.modelUsed,
        attempts: s.attempts,
      })),
    });
  }
}

/**
 * Display per-model efficiency metrics.
 *
 * @param workdir - Project root directory
 *
 * @example
 * ```bash
 * nax status --cost --model
 * ```
 */
export async function displayModelEfficiency(workdir: string): Promise<void> {
  const logger = getLogger();
  const runs = await loadRunMetrics(workdir);

  if (runs.length === 0) {
    logger.info("cli", "No metrics data available yet", { hint: "Run nax run to generate metrics" });
    return;
  }

  const aggregate = calculateAggregateMetrics(runs);

  // Sort models by total cost (descending)
  const sortedModels = Object.entries(aggregate.modelEfficiency).sort(([, a], [, b]) => b.totalCost - a.totalCost);

  if (sortedModels.length === 0) {
    logger.info("cli", "No model data available");
    return;
  }

  logger.info("cli", "Model Efficiency", {
    models: sortedModels.map(([modelName, stats]) => ({
      model: modelName,
      attempts: stats.attempts,
      passRate: stats.passRate,
      avgCost: stats.avgCost,
      totalCost: stats.totalCost,
    })),
  });

  // Show complexity accuracy
  const sortedComplexity = Object.entries(aggregate.complexityAccuracy).sort(
    ([, a], [, b]) => b.predicted - a.predicted,
  );

  if (sortedComplexity.length === 0) {
    logger.info("cli", "No complexity data available");
    return;
  }

  logger.info("cli", "Complexity Prediction Accuracy", {
    complexities: sortedComplexity.map(([complexity, stats]) => ({
      complexity,
      predicted: stats.predicted,
      actualTierUsed: stats.actualTierUsed,
      mismatchRate: stats.mismatchRate,
    })),
  });
}
