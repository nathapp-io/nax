/**
 * Status CLI Command
 *
 * Display cost metrics, run statistics, and feature progress.
 * Includes active run detection via status.json + PID check.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { resolveProject } from "../commands/common";
import type { NaxStatusFile } from "../execution/status-file";
import { listPendingInteractions, loadPendingInteraction } from "../interaction";
import { getLogger } from "../logger";
import { calculateAggregateMetrics, getLastRun, loadRunMetrics } from "../metrics";
import { countStories, loadPRD } from "../prd";

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

// ============================================================================
// Feature Status Display
// ============================================================================

/**
 * Options for feature status command
 */
export interface FeatureStatusOptions {
  /** Feature name (from -f flag) */
  feature?: string;
  /** Explicit project directory (from -d flag) */
  dir?: string;
}

/**
 * Feature summary for the all-features table
 */
interface FeatureSummary {
  name: string;
  done: number;
  failed: number;
  pending: number;
  total: number;
  lastRun?: string;
  cost?: number;
  activeRun?: {
    runId: string;
    pid: number;
    startedAt: string;
  };
  crashedRun?: {
    runId: string;
    pid: number;
    crashedAt?: string;
  };
}

/**
 * Check if a process is alive via PID check
 *
 * @param pid - Process ID to check
 * @returns true if process is running, false otherwise
 */
function isPidAlive(pid: number): boolean {
  try {
    // On macOS/Linux, use ps to check if PID exists
    // ps -p <pid> exits with 0 if process exists, 1 otherwise
    const result = Bun.spawnSync(["ps", "-p", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Load status.json for a feature (if it exists)
 *
 * @param featureDir - Absolute path to feature directory
 * @returns Parsed status file or null if not found/invalid
 */
async function loadStatusFile(featureDir: string): Promise<NaxStatusFile | null> {
  const statusPath = join(featureDir, "status.json");
  if (!existsSync(statusPath)) {
    return null;
  }

  try {
    const content = Bun.file(statusPath);
    return (await content.json()) as NaxStatusFile;
  } catch {
    return null;
  }
}

/**
 * Get feature summary from prd.json and optional status.json
 *
 * @param featureName - Feature name
 * @param featureDir - Absolute path to feature directory
 * @returns Feature summary with counts, last run, cost
 */
async function getFeatureSummary(featureName: string, featureDir: string): Promise<FeatureSummary> {
  const prdPath = join(featureDir, "prd.json");

  // Load PRD for story counts
  const prd = await loadPRD(prdPath);
  const counts = countStories(prd);

  const summary: FeatureSummary = {
    name: featureName,
    done: counts.passed,
    failed: counts.failed,
    pending: counts.pending,
    total: counts.total,
  };

  // Load status.json if available
  const status = await loadStatusFile(featureDir);
  if (status) {
    summary.cost = status.cost.spent;

    // Check if run is active or crashed
    const pidAlive = isPidAlive(status.run.pid);

    if (status.run.status === "running" && pidAlive) {
      summary.activeRun = {
        runId: status.run.id,
        pid: status.run.pid,
        startedAt: status.run.startedAt,
      };
    } else if (status.run.status === "running" && !pidAlive) {
      // Run is marked "running" but PID is dead — crashed
      summary.crashedRun = {
        runId: status.run.id,
        pid: status.run.pid,
        crashedAt: status.run.crashedAt,
      };
    } else if (status.run.status === "crashed") {
      // Run explicitly marked as crashed
      summary.crashedRun = {
        runId: status.run.id,
        pid: status.run.pid,
        crashedAt: status.run.crashedAt,
      };
    }
  }

  // Get last run timestamp from runs/ directory
  const runsDir = join(featureDir, "runs");
  if (existsSync(runsDir)) {
    const runs = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl") && e.name !== "latest.jsonl")
      .map((e) => e.name)
      .sort()
      .reverse();

    if (runs.length > 0) {
      // Extract timestamp from filename (YYYY-MM-DDTHH-MM-SS.jsonl)
      const latestRun = runs[0].replace(".jsonl", "");
      summary.lastRun = latestRun;
    }
  }

  return summary;
}

/**
 * Display all features table
 *
 * @param projectDir - Absolute path to project root
 */
async function displayAllFeatures(projectDir: string): Promise<void> {
  const featuresDir = join(projectDir, "nax", "features");

  if (!existsSync(featuresDir)) {
    console.log(chalk.dim("No features found."));
    return;
  }

  const features = readdirSync(featuresDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  if (features.length === 0) {
    console.log(chalk.dim("No features found."));
    return;
  }

  // Load summaries for all features
  const summaries = await Promise.all(features.map((name) => getFeatureSummary(name, join(featuresDir, name))));

  console.log(chalk.bold("\n📊 Features\n"));

  // Print table header
  const header = `  ${"Feature".padEnd(25)} ${"Done".padEnd(6)} ${"Failed".padEnd(8)} ${"Pending".padEnd(9)} ${"Last Run".padEnd(22)} ${"Cost".padEnd(10)} Status`;
  console.log(chalk.dim(header));
  console.log(chalk.dim(`  ${"─".repeat(100)}`));

  // Print each feature row
  for (const summary of summaries) {
    const name = summary.name.padEnd(25);
    const done = chalk.green(String(summary.done).padEnd(6));
    const failed =
      summary.failed > 0 ? chalk.red(String(summary.failed).padEnd(8)) : chalk.dim(String(summary.failed).padEnd(8));
    const pending = chalk.dim(String(summary.pending).padEnd(9));
    const lastRun = summary.lastRun ? summary.lastRun.padEnd(22) : chalk.dim("No runs yet".padEnd(22));
    const cost = summary.cost !== undefined ? `$${summary.cost.toFixed(4)}`.padEnd(10) : chalk.dim("—".padEnd(10));

    let status = "";
    if (summary.activeRun) {
      status = chalk.yellow("⚡ Running");
    } else if (summary.crashedRun) {
      status = chalk.red("💥 Crashed");
    } else {
      status = chalk.dim("—");
    }

    console.log(`  ${name} ${done} ${failed} ${pending} ${lastRun} ${cost} ${status}`);
  }

  console.log();
}

/**
 * Display single feature details
 *
 * @param featureName - Feature name
 * @param featureDir - Absolute path to feature directory
 */
async function displayFeatureDetails(featureName: string, featureDir: string): Promise<void> {
  const prdPath = join(featureDir, "prd.json");
  const prd = await loadPRD(prdPath);
  const counts = countStories(prd);

  // Load status.json if available
  const status = await loadStatusFile(featureDir);

  console.log(chalk.bold(`\n📊 ${prd.feature}\n`));

  // Check for pending interactions
  const pendingIds = await listPendingInteractions(featureDir);
  if (pendingIds.length > 0) {
    console.log(chalk.cyan(`⏸️  Paused — Waiting for Interaction (${pendingIds.length} pending)\n`));

    for (const id of pendingIds) {
      const req = await loadPendingInteraction(id, featureDir);
      if (req) {
        const safety = req.metadata?.safety ?? "unknown";
        const safetyIcon = safety === "red" ? "🔴" : safety === "yellow" ? "🟡" : "🟢";
        const timeRemaining = req.timeout ? Math.max(0, req.createdAt + req.timeout - Date.now()) : null;
        const timeoutSec = timeRemaining !== null ? Math.floor(timeRemaining / 1000) : null;

        console.log(`   ${safetyIcon} ${chalk.bold(req.id)}`);
        console.log(chalk.dim(`      Type:     ${req.type}`));
        console.log(chalk.dim(`      Summary:  ${req.summary}`));
        console.log(chalk.dim(`      Fallback: ${req.fallback}`));
        if (timeoutSec !== null) {
          if (timeoutSec > 0) {
            console.log(chalk.dim(`      Timeout:  ${timeoutSec}s remaining`));
          } else {
            console.log(chalk.red("      Timeout:  EXPIRED"));
          }
        }
        console.log();
      }
    }

    console.log(chalk.dim("   💡 Respond with: nax interact respond <id> --action approve|reject|skip|abort"));
    console.log();
  }

  // Display run status if active or crashed
  if (status) {
    const pidAlive = isPidAlive(status.run.pid);

    if (status.run.status === "running" && pidAlive) {
      console.log(chalk.yellow("⚡ Active Run:"));
      console.log(chalk.dim(`   Run ID:     ${status.run.id}`));
      console.log(chalk.dim(`   PID:        ${status.run.pid}`));
      console.log(chalk.dim(`   Started:    ${status.run.startedAt}`));
      console.log(chalk.dim(`   Progress:   ${status.progress.passed}/${status.progress.total} stories`));
      console.log(chalk.dim(`   Cost:       $${status.cost.spent.toFixed(4)}`));

      if (status.current) {
        console.log(chalk.dim(`   Current:    ${status.current.storyId} - ${status.current.title}`));
      }

      console.log();
    } else if ((status.run.status === "running" && !pidAlive) || status.run.status === "crashed") {
      console.log(chalk.red("💥 Crashed Run Detected:\n"));
      console.log(chalk.dim(`   Run ID:     ${status.run.id}`));
      console.log(chalk.dim(`   PID:        ${status.run.pid} (dead)`));
      console.log(chalk.dim(`   Started:    ${status.run.startedAt}`));
      if (status.run.crashedAt) {
        console.log(chalk.dim(`   Crashed:    ${status.run.crashedAt}`));
      }
      if (status.run.crashSignal) {
        console.log(chalk.dim(`   Signal:     ${status.run.crashSignal}`));
      }
      console.log(chalk.dim(`   Progress:   ${status.progress.passed}/${status.progress.total} stories (at crash)`));
      console.log();
      console.log(chalk.yellow("💡 Recovery Hints:"));
      console.log(chalk.dim("   • Check the latest run log in runs/ directory"));
      console.log(chalk.dim("   • Review status.json for last known state"));
      console.log(chalk.dim(`   • Re-run with: nax run -f ${featureName}`));
      console.log();
    }
  } else {
    console.log(chalk.dim("No active run (status.json not found)\n"));
  }

  // Display story counts
  console.log(chalk.bold("Progress:"));
  console.log(chalk.dim(`   Branch:     ${prd.branchName}`));
  console.log(chalk.dim(`   Updated:    ${prd.updatedAt}`));
  console.log(chalk.dim(`   Total:      ${counts.total}`));
  console.log(chalk.green(`   Passed:     ${counts.passed}`));
  console.log(chalk.red(`   Failed:     ${counts.failed}`));
  console.log(chalk.dim(`   Pending:    ${counts.pending}`));
  if (counts.skipped > 0) {
    console.log(chalk.yellow(`   Skipped:    ${counts.skipped}`));
  }
  console.log();

  // Display story table
  console.log(chalk.bold("Stories:\n"));
  for (const story of prd.userStories) {
    const icon = story.passes ? "✅" : story.status === "failed" ? "❌" : story.status === "skipped" ? "⏭️" : "⬜";
    const routing = story.routing
      ? chalk.dim(` [${story.routing.complexity}/${story.routing.modelTier}/${story.routing.testStrategy}]`)
      : "";
    console.log(`   ${icon} ${story.id}: ${story.title}${routing}`);
  }

  console.log();

  // Display last run info if completed
  if (status && status.run.status !== "running") {
    console.log(chalk.dim(`Last run: ${status.run.id}`));
    console.log(chalk.dim(`Cost: $${status.cost.spent.toFixed(4)}`));
    console.log();
  }
}

/**
 * Display feature status (all features table or single feature details)
 *
 * @param options - Command options
 *
 * @example
 * ```bash
 * # Show all features
 * nax status
 *
 * # Show single feature details
 * nax status -f structured-logging
 * ```
 */
export async function displayFeatureStatus(options: FeatureStatusOptions = {}): Promise<void> {
  const resolved = resolveProject({
    dir: options.dir,
    feature: options.feature,
  });

  if (options.feature) {
    // Single feature view
    if (!resolved.featureDir) {
      throw new Error("Feature directory not resolved (this should not happen)");
    }
    await displayFeatureDetails(options.feature, resolved.featureDir);
  } else {
    // All features table
    await displayAllFeatures(resolved.projectDir);
  }
}
