/**
 * Metrics Aggregator
 *
 * Calculates aggregate metrics across all runs.
 */

import type { RunMetrics, AggregateMetrics, StoryMetrics } from "./types";

/**
 * Calculate aggregate metrics across all runs.
 *
 * Analyzes historical data to compute:
 * - Overall success rates
 * - Per-model efficiency
 * - Complexity prediction accuracy
 * - Cost statistics
 *
 * @param runs - Array of all historical run metrics
 * @returns Aggregate metrics
 *
 * @example
 * ```ts
 * const runs = await loadRunMetrics(workdir);
 * const aggregate = calculateAggregateMetrics(runs);
 * console.log(`First pass rate: ${(aggregate.firstPassRate * 100).toFixed(1)}%`);
 * console.log(`Avg cost per story: $${aggregate.avgCostPerStory.toFixed(4)}`);
 * ```
 */
export function calculateAggregateMetrics(runs: RunMetrics[]): AggregateMetrics {
  if (runs.length === 0) {
    return {
      totalRuns: 0,
      totalCost: 0,
      totalStories: 0,
      firstPassRate: 0,
      escalationRate: 0,
      avgCostPerStory: 0,
      avgCostPerFeature: 0,
      modelEfficiency: {},
      complexityAccuracy: {},
    };
  }

  // Flatten all story metrics
  const allStories: StoryMetrics[] = runs.flatMap((run) => run.stories);

  const totalRuns = runs.length;
  const totalCost = runs.reduce((sum, run) => sum + run.totalCost, 0);
  const totalStories = allStories.length;

  // Calculate first pass rate
  const firstPassSuccesses = allStories.filter((s) => s.firstPassSuccess).length;
  const firstPassRate = totalStories > 0 ? firstPassSuccesses / totalStories : 0;

  // Calculate escalation rate (stories that needed more than 1 attempt)
  const escalatedStories = allStories.filter((s) => s.attempts > 1).length;
  const escalationRate = totalStories > 0 ? escalatedStories / totalStories : 0;

  // Average costs
  const avgCostPerStory = totalStories > 0 ? totalCost / totalStories : 0;
  const avgCostPerFeature = totalRuns > 0 ? totalCost / totalRuns : 0;

  // Per-model efficiency
  const modelStats = new Map<
    string,
    {
      attempts: number;
      successes: number;
      totalCost: number;
    }
  >();

  for (const story of allStories) {
    const modelKey = story.modelUsed;
    const existing = modelStats.get(modelKey) || {
      attempts: 0,
      successes: 0,
      totalCost: 0,
    };

    modelStats.set(modelKey, {
      attempts: existing.attempts + story.attempts,
      successes: existing.successes + (story.success ? 1 : 0),
      totalCost: existing.totalCost + story.cost,
    });
  }

  const modelEfficiency: AggregateMetrics["modelEfficiency"] = {};
  for (const [modelKey, stats] of modelStats) {
    const passRate = stats.attempts > 0 ? stats.successes / stats.attempts : 0;
    const avgCost = stats.successes > 0 ? stats.totalCost / stats.successes : 0;

    modelEfficiency[modelKey] = {
      attempts: stats.attempts,
      successes: stats.successes,
      passRate,
      avgCost,
      totalCost: stats.totalCost,
    };
  }

  // Complexity prediction accuracy
  const complexityStats = new Map<
    string,
    {
      predicted: number;
      tierCounts: Map<string, number>;
      mismatches: number;
    }
  >();

  for (const story of allStories) {
    const complexity = story.complexity;
    const existing = complexityStats.get(complexity) || {
      predicted: 0,
      tierCounts: new Map<string, number>(),
      mismatches: 0,
    };

    existing.predicted += 1;

    // Track which tier was actually used
    const finalTier = story.finalTier;
    existing.tierCounts.set(finalTier, (existing.tierCounts.get(finalTier) || 0) + 1);

    // Count as mismatch if escalated (initial tier != final tier)
    if (story.modelTier !== story.finalTier) {
      existing.mismatches += 1;
    }

    complexityStats.set(complexity, existing);
  }

  const complexityAccuracy: AggregateMetrics["complexityAccuracy"] = {};
  for (const [complexity, stats] of complexityStats) {
    // Find most common final tier
    let maxCount = 0;
    let mostCommonTier = "unknown";
    for (const [tier, count] of stats.tierCounts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonTier = tier;
      }
    }

    const mismatchRate = stats.predicted > 0 ? stats.mismatches / stats.predicted : 0;

    complexityAccuracy[complexity] = {
      predicted: stats.predicted,
      actualTierUsed: mostCommonTier,
      mismatchRate,
    };
  }

  return {
    totalRuns,
    totalCost,
    totalStories,
    firstPassRate,
    escalationRate,
    avgCostPerStory,
    avgCostPerFeature,
    modelEfficiency,
    complexityAccuracy,
  };
}

/**
 * Get the last run metrics from the list.
 *
 * @param runs - Array of all run metrics
 * @returns Most recent run, or null if no runs
 *
 * @example
 * ```ts
 * const runs = await loadRunMetrics(workdir);
 * const lastRun = getLastRun(runs);
 * if (lastRun) {
 *   console.log(`Last run: ${lastRun.feature} (${lastRun.storiesCompleted}/${lastRun.totalStories} stories)`);
 * }
 * ```
 */
export function getLastRun(runs: RunMetrics[]): RunMetrics | null {
  if (runs.length === 0) {
    return null;
  }

  // Runs are appended chronologically, so last element is most recent
  return runs[runs.length - 1];
}
