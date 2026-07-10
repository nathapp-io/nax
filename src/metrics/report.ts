/**
 * Cost Report Mapper
 *
 * Pure, side-effect-free mapper that converts internal run metrics into the
 * stable public `CostReportV1` contract. No I/O, no logger, no Date.now.
 *
 * The contract deliberately strips internal fields (`totalTokens`, `context`,
 * `pollution`, `complexityAccuracy`, `fallback`) so consumers can rely on the
 * shape independent of internal refactors.
 */

import { NaxError } from "../errors";
import { calculateAggregateMetrics, getLastRun } from "./aggregator";
import type { AggregateMetrics, RunMetrics } from "./types";

/**
 * Public stable report shape. Versioned via `schemaVersion` so downstream
 * consumers can branch on contract changes.
 */
export interface CostReportV1 {
  schemaVersion: "1.0";
  project: string;
  generatedAt: string;
  aggregate: CostAggregate | null;
  lastRun: CostRunSummary | null;
  modelEfficiency: CostModelStat[];
}

export interface CostAggregate {
  totalRuns: number;
  totalStories: number;
  totalCost: number;
  avgCostPerStory: number;
  avgCostPerFeature: number;
  firstPassRate: number;
  escalationRate: number;
}

export interface CostRunSummary {
  runId: string;
  feature: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalStories: number;
  storiesCompleted: number;
  storiesFailed: number;
  totalCost: number;
  avgCostPerStory: number;
  stories: CostStory[];
}

export interface CostStory {
  storyId: string;
  cost: number;
  model: string;
  attempts: number;
}

export interface CostModelStat {
  model: string;
  attempts: number;
  passRate: number;
  avgCost: number;
  totalCost: number;
}

/**
 * Injectable dependencies for the pure mapper. Callers can supply a frozen
 * `now()` for deterministic timestamps.
 */
export interface CostReportDeps {
  now: () => string;
  project: string;
}

const SCHEMA_VERSION = "1.0" as const;
const FORBIDDEN_INTERNAL_KEYS = ["totalTokens", "context", "pollution", "complexityAccuracy", "fallback"] as const;

/**
 * Convert internal run metrics into the public `CostReportV1` shape.
 *
 * Composition-only: aggregates via `calculateAggregateMetrics`, picks the
 * last run via `getLastRun`, and curates a fresh plain-object tree so
 * internal fields never leak into the contract.
 */
export function toCostReport(runs: RunMetrics[], deps: CostReportDeps): CostReportV1 {
  const metrics = runs.length === 0 ? null : calculateAggregateMetrics(runs);
  const aggregate = buildAggregate(metrics);
  const lastRun = buildLastRun(runs);
  const modelEfficiency = buildModelEfficiency(metrics);

  const report: CostReportV1 = {
    schemaVersion: SCHEMA_VERSION,
    project: deps.project,
    generatedAt: deps.now(),
    aggregate,
    lastRun,
    modelEfficiency,
  };

  return stripInternalFields(report);
}

function buildAggregate(metrics: AggregateMetrics | null): CostAggregate | null {
  if (!metrics) return null;
  return {
    totalRuns: metrics.totalRuns,
    totalStories: metrics.totalStories,
    totalCost: metrics.totalCost,
    avgCostPerStory: metrics.avgCostPerStory,
    avgCostPerFeature: metrics.avgCostPerFeature,
    firstPassRate: metrics.firstPassRate,
    escalationRate: metrics.escalationRate,
  };
}

function buildLastRun(runs: RunMetrics[]): CostRunSummary | null {
  const last = getLastRun(runs);
  if (!last) return null;

  const totalStories = last.totalStories;
  const totalCost = last.totalCost;
  const avgCostPerStory = totalStories === 0 ? 0 : totalCost / totalStories;

  const stories = [...last.stories]
    .sort((a, b) => b.cost - a.cost)
    .map((s) => ({
      storyId: s.storyId,
      cost: s.cost,
      model: s.modelUsed,
      attempts: s.attempts,
    }));

  return {
    runId: last.runId,
    feature: last.feature,
    startedAt: last.startedAt,
    completedAt: last.completedAt,
    durationMs: last.totalDurationMs,
    totalStories,
    storiesCompleted: last.storiesCompleted,
    storiesFailed: last.storiesFailed,
    totalCost,
    avgCostPerStory,
    stories,
  };
}

function buildModelEfficiency(metrics: AggregateMetrics | null): CostModelStat[] {
  if (!metrics) return [];
  return Object.entries(metrics.modelEfficiency)
    .map(([model, stat]) => ({
      model,
      attempts: stat.attempts,
      passRate: stat.passRate,
      avgCost: stat.avgCost,
      totalCost: stat.totalCost,
    }))
    .sort((x, y) => y.totalCost - x.totalCost);
}

function stripInternalFields(report: CostReportV1): CostReportV1 {
  // Defense in depth: the curated shapes above already exclude internal
  // fields, but ASSERT that forbidden keys never appear in the contract.
  // This guards against future internal refactors that silently leak.
  assertNoInternalFields(report, "<root>");
  if (report.aggregate) assertNoInternalFields(report.aggregate, "aggregate");
  if (report.lastRun) {
    assertNoInternalFields(report.lastRun, "lastRun");
    for (const story of report.lastRun.stories) {
      assertNoInternalFields(story, "lastRun.stories[]");
    }
  }
  return report;
}

function assertNoInternalFields<T extends object>(value: T, path: string): void {
  for (const key of FORBIDDEN_INTERNAL_KEYS) {
    if (key in (value as Record<string, unknown>)) {
      throw new NaxError(
        `[metrics/report] forbidden internal field "${key}" leaked at ${path}`,
        "COST_REPORT_LEAKED_INTERNAL_FIELD",
        { path, field: key },
      );
    }
  }
}
