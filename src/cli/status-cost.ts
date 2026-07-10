/**
 * Status Cost Metrics
 *
 * Extracted from status.ts: cost metrics display functions for CLI output.
 */

import { basename } from "node:path";
import { loadConfig } from "../config";
import { getLogger } from "../logger";
import { calculateAggregateMetrics, getLastRun, loadRunMetrics, toCostReport } from "../metrics";
import type { CostReportV1 } from "../metrics";
import type { RunMetrics } from "../metrics/types";
import { projectOutputDir } from "../runtime";

async function resolveProjectKey(workdir: string): Promise<string> {
  const config = await loadConfig(workdir).catch(() => null);
  return config?.name?.trim() || basename(workdir);
}

async function resolveOutputDir(workdir: string): Promise<string> {
  const config = await loadConfig(workdir).catch(() => null);
  const projectKey = config?.name?.trim() || basename(workdir);
  return projectOutputDir(projectKey, config?.outputDir);
}

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
  const outputDir = await resolveOutputDir(workdir);
  const runs = await loadRunMetrics(outputDir);

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
  const outputDir = await resolveOutputDir(workdir);
  const runs = await loadRunMetrics(outputDir);

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

  // Amendment A AC-48: warn when any story's pollution ratio exceeds threshold
  const POLLUTION_WARN_THRESHOLD = 0.3;
  for (const story of lastRun.stories) {
    const ratio = story.context?.pollution?.pollutionRatio;
    if (ratio !== undefined && ratio > POLLUTION_WARN_THRESHOLD) {
      logger.warn("cli", "High context pollution detected — review context.md for stale entries", {
        storyId: story.storyId,
        pollutionRatio: ratio,
        contradictedChunks: story.context?.pollution?.contradictedChunks ?? 0,
        ignoredChunks: story.context?.pollution?.ignoredChunks ?? 0,
      });
    }
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
  const outputDir = await resolveOutputDir(workdir);
  const runs = await loadRunMetrics(outputDir);

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

/**
 * Injectable dependencies for `emitCostReportJson`.
 *
 * Mirrors the `ReplayCommandDeps` pattern: production callers get the
 * filesystem-backed defaults via `_costReportEmitDeps`; tests inject spies.
 */
export interface CostReportEmitDeps {
  loadRuns: (outputDir: string) => Promise<RunMetrics[]>;
  resolveProject: (workdir: string) => Promise<string>;
  toCostReport: (runs: RunMetrics[], reportDeps: { now: () => string; project: string }) => CostReportV1;
  now: () => string;
  stdout: (text: string) => void;
}

export const _costReportEmitDeps: CostReportEmitDeps = {
  loadRuns: (outputDir: string) => loadRunMetrics(outputDir),
  resolveProject: resolveProjectKey,
  toCostReport,
  now: () => new Date().toISOString(),
  stdout: (text: string) => process.stdout.write(text),
};

/**
 * Emit a stable pretty-printed `CostReportV1` object to stdout.
 *
 * I/O failures from `loadRuns` propagate unchanged so callers can surface them.
 * The report always includes aggregate, last-run, and model-efficiency sections,
 * which is why `--last` and `--model` are ignored when `--json` is set.
 */
export async function emitCostReportJson(
  workdir: string,
  deps: CostReportEmitDeps = _costReportEmitDeps,
): Promise<void> {
  const outputDir = await resolveOutputDir(workdir);
  const runs = await deps.loadRuns(outputDir);
  const project = await deps.resolveProject(workdir);
  const report = deps.toCostReport(runs, { now: deps.now, project });
  deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
}
