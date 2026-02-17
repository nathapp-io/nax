/**
 * Status CLI Command
 *
 * Display cost metrics and run statistics.
 */

import chalk from "chalk";
import {
  loadRunMetrics,
  calculateAggregateMetrics,
  getLastRun,
  type AggregateMetrics,
  type RunMetrics,
} from "../metrics";

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
  const runs = await loadRunMetrics(workdir);

  if (runs.length === 0) {
    console.log(chalk.yellow("\nNo metrics data available yet."));
    console.log(chalk.dim("   Run nax run to generate metrics."));
    return;
  }

  const aggregate = calculateAggregateMetrics(runs);

  console.log(chalk.bold("\n💰 Cost Metrics (All Runs)"));
  console.log(chalk.dim("─".repeat(60)));
  console.log(`   Total Runs:        ${aggregate.totalRuns}`);
  console.log(`   Total Stories:     ${aggregate.totalStories}`);
  console.log(`   Total Cost:        ${chalk.green(`$${aggregate.totalCost.toFixed(4)}`)}`);
  console.log(`   Avg Cost/Story:    ${chalk.cyan(`$${aggregate.avgCostPerStory.toFixed(4)}`)}`);
  console.log(`   Avg Cost/Feature:  ${chalk.cyan(`$${aggregate.avgCostPerFeature.toFixed(4)}`)}`);
  console.log();
  console.log(`   First Pass Rate:   ${formatRate(aggregate.firstPassRate)}`);
  console.log(`   Escalation Rate:   ${formatRate(aggregate.escalationRate)}`);
  console.log();
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
  const runs = await loadRunMetrics(workdir);

  if (runs.length === 0) {
    console.log(chalk.yellow("\nNo metrics data available yet."));
    console.log(chalk.dim("   Run nax run to generate metrics."));
    return;
  }

  const lastRun = getLastRun(runs);
  if (!lastRun) {
    return;
  }

  console.log(chalk.bold(`\n📊 Last Run: ${lastRun.feature}`));
  console.log(chalk.dim("─".repeat(60)));
  console.log(`   Run ID:            ${lastRun.runId}`);
  console.log(`   Started:           ${formatTimestamp(lastRun.startedAt)}`);
  console.log(`   Completed:         ${formatTimestamp(lastRun.completedAt)}`);
  console.log(`   Duration:          ${formatDuration(lastRun.totalDurationMs)}`);
  console.log();
  console.log(`   Total Stories:     ${lastRun.totalStories}`);
  console.log(`   Completed:         ${chalk.green(lastRun.storiesCompleted.toString())}`);
  console.log(`   Failed:            ${chalk.red(lastRun.storiesFailed.toString())}`);
  console.log();
  console.log(`   Total Cost:        ${chalk.green(`$${lastRun.totalCost.toFixed(4)}`)}`);
  console.log(`   Avg Cost/Story:    ${chalk.cyan(`$${(lastRun.totalCost / lastRun.totalStories).toFixed(4)}`)}`);
  console.log();

  // Show top 5 most expensive stories
  const sortedStories = [...lastRun.stories].sort((a, b) => b.cost - a.cost);
  const topStories = sortedStories.slice(0, 5);

  if (topStories.length > 0) {
    console.log(chalk.bold("   Top 5 Most Expensive Stories:"));
    for (const story of topStories) {
      const costStr = chalk.cyan(`$${story.cost.toFixed(4)}`);
      const modelStr = chalk.dim(`[${story.modelUsed}]`);
      const attemptsStr = story.attempts > 1 ? chalk.yellow(` (${story.attempts} attempts)`) : "";
      console.log(`     ${story.storyId}: ${costStr} ${modelStr}${attemptsStr}`);
    }
    console.log();
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
  const runs = await loadRunMetrics(workdir);

  if (runs.length === 0) {
    console.log(chalk.yellow("\nNo metrics data available yet."));
    console.log(chalk.dim("   Run nax run to generate metrics."));
    return;
  }

  const aggregate = calculateAggregateMetrics(runs);

  console.log(chalk.bold("\n🤖 Model Efficiency"));
  console.log(chalk.dim("─".repeat(60)));

  // Sort models by total cost (descending)
  const sortedModels = Object.entries(aggregate.modelEfficiency).sort(
    ([, a], [, b]) => b.totalCost - a.totalCost,
  );

  if (sortedModels.length === 0) {
    console.log(chalk.dim("   No model data available"));
    return;
  }

  console.log(chalk.dim("   Model                   Attempts    Success    Avg Cost    Total Cost"));
  console.log(chalk.dim("   " + "─".repeat(75)));

  for (const [modelName, stats] of sortedModels) {
    const modelStr = modelName.padEnd(24);
    const attemptsStr = stats.attempts.toString().padStart(8);
    const successRate = formatRate(stats.passRate).padStart(10);
    const avgCost = chalk.cyan(`$${stats.avgCost.toFixed(4)}`).padStart(18);
    const totalCost = chalk.green(`$${stats.totalCost.toFixed(4)}`).padStart(18);

    console.log(`   ${modelStr}${attemptsStr}    ${successRate}    ${avgCost}    ${totalCost}`);
  }
  console.log();

  // Show complexity accuracy
  console.log(chalk.bold("\n📈 Complexity Prediction Accuracy"));
  console.log(chalk.dim("─".repeat(60)));

  const sortedComplexity = Object.entries(aggregate.complexityAccuracy).sort(
    ([, a], [, b]) => b.predicted - a.predicted,
  );

  if (sortedComplexity.length === 0) {
    console.log(chalk.dim("   No complexity data available"));
    return;
  }

  console.log(chalk.dim("   Complexity       Predicted    Actual Tier      Mismatch Rate"));
  console.log(chalk.dim("   " + "─".repeat(70)));

  for (const [complexity, stats] of sortedComplexity) {
    const complexityStr = complexity.padEnd(16);
    const predictedStr = stats.predicted.toString().padStart(10);
    const actualTierStr = stats.actualTierUsed.padEnd(16);
    const mismatchStr = formatRate(stats.mismatchRate);

    console.log(`   ${complexityStr}${predictedStr}    ${actualTierStr}    ${mismatchStr}`);
  }
  console.log();
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Format a rate (0-1) as a percentage string with color.
 *
 * @param rate - Rate value between 0 and 1
 * @returns Formatted percentage with color
 */
function formatRate(rate: number): string {
  const percentage = (rate * 100).toFixed(1);
  const value = Number.parseFloat(percentage);

  // Color code: green >= 80%, yellow >= 50%, red < 50%
  if (value >= 80) {
    return chalk.green(`${percentage}%`);
  }
  if (value >= 50) {
    return chalk.yellow(`${percentage}%`);
  }
  return chalk.red(`${percentage}%`);
}

/**
 * Format ISO timestamp as human-readable local time.
 *
 * @param isoString - ISO 8601 timestamp
 * @returns Formatted timestamp
 */
function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

/**
 * Format duration in milliseconds as human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration (e.g., "5m 23s")
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}
