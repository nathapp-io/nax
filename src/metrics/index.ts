/**
 * Metrics Tracking
 *
 * Per-story and per-run cost tracking for data-driven routing optimization.
 */

export type {
  AgentFallbackHop,
  AggregateMetrics,
  RunFallbackAggregate,
  RunMetrics,
  StoryMetrics,
  TokenUsage,
} from "./types";
export {
  collectStoryMetrics,
  collectBatchMetrics,
  saveRunMetrics,
  loadRunMetrics,
} from "./tracker";
export { calculateAggregateMetrics, deriveRunFallbackAggregates, getLastRun } from "./aggregator";
export {
  toCostReport,
  type CostAggregate,
  type CostModelStat,
  type CostReportDeps,
  type CostReportV1,
  type CostRunSummary,
  type CostStory,
} from "./report";
