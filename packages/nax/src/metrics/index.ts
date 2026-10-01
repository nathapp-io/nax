/**
 * Metrics Tracking
 *
 * Per-story and per-run cost tracking for data-driven routing optimization.
 */

export { calculateAggregateMetrics, deriveRunFallbackAggregates, getLastRun } from "./aggregator";
export {
  type CostAggregate,
  type CostModelStat,
  type CostReportDeps,
  type CostReportV1,
  type CostRunSummary,
  type CostStory,
  toCostReport,
} from "./report";
export {
  collectBatchMetrics,
  collectStoryMetrics,
  loadRunMetrics,
  MAX_RETAINED_RUNS,
  metricsPathFor,
  saveRunMetrics,
  toFallbackHops,
} from "./tracker";
export type {
  AgentFallbackHop,
  AggregateMetrics,
  RunFallbackAggregate,
  RunMetrics,
  StoryMetrics,
  TokenUsage,
} from "./types";
