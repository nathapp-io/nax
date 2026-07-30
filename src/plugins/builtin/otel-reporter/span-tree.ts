import type { PhaseCompleteEvent } from "@/plugins/types";
import type { KeyValue } from "./otlp";

/** Fixed bucket boundaries for the `nax.phase.duration` histogram, in milliseconds. */
export const PHASE_DURATION_BOUNDS = [100, 500, 1000, 5000, 15000, 60000, 300000, 900000];

/** Fixed bucket boundaries for the `nax.phase.cost_usd` histogram, in USD. */
export const PHASE_COST_BOUNDS = [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5];

export interface HistogramDataPoint {
  attributes: KeyValue[];
  timeUnixNano: string;
  count: number;
  sum: number;
  bucketCounts: number[];
  explicitBounds: number[];
}

/** Build an OTLP histogram data point. `bucketCounts` has `bounds.length + 1` entries. */
export function buildHistogramPoint(
  values: number[],
  bounds: number[],
  attributes: KeyValue[],
  timeUnixNano: string,
): HistogramDataPoint {
  return { attributes, timeUnixNano, count: 0, sum: 0, bucketCounts: [], explicitBounds: bounds };
}

export interface CounterDataPoint {
  attributes: KeyValue[];
  timeUnixNano: string;
  asInt: string;
}

/** Build an OTLP monotonic-sum (counter) data point. */
export function buildCounterPoint(count: number, attributes: KeyValue[], timeUnixNano: string): CounterDataPoint {
  return { attributes, timeUnixNano, asInt: "0" };
}

/** Resource attributes shared by every OTLP payload this reporter exports. */
export function buildResourceAttributes(serviceName: string, runId: string): KeyValue[] {
  return [];
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
}

export interface PhaseSpanInput {
  event: PhaseCompleteEvent;
  traceId: string;
  startUnixNano: string;
  endUnixNano: string;
}

export interface SpanTree {
  readonly traceId: string;
  readonly runSpanId: string;
  /** Returns the `nax.story` span id for a story, creating one on first reference. */
  storySpanId(storyId: string): string;
  /** Build a `nax.story` span parented directly to the run span. */
  buildStorySpan(storyId: string, startUnixNano: string, endUnixNano: string): Span;
  /** Build a `nax.phase` span parented to its story span (scope "story") or the run span (scope "run"). */
  buildPhaseSpan(input: PhaseSpanInput): Span;
}

/** Tracks `nax.run` -> `nax.story` -> `nax.phase` span parentage for one run's trace. */
export function createSpanTree(traceId: string, runSpanId: string): SpanTree {
  const stub: Span = {
    traceId,
    spanId: "",
    parentSpanId: "",
    name: "",
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    attributes: [],
  };
  return { traceId, runSpanId, storySpanId: () => "", buildStorySpan: () => stub, buildPhaseSpan: () => stub };
}

export interface PhaseMetricsAggregator {
  /** Record a `story:phase:completed` / run-scope phase completion into the duration + cost histograms. */
  recordPhase(event: PhaseCompleteEvent): void;
  /** Record review findings for `nax.review.findings`, tagged with `severity`. */
  recordReviewFindings(phase: string, severity: string, count: number): void;
  /** Record rectification iterations for `nax.fix.iterations`, tagged with `strategy`. */
  recordFixIterations(phase: string, strategy: string, count: number): void;
  /** Record a `story:escalated` event for `nax.escalations`, tagged with `to_tier`. */
  recordEscalation(toTier: string, count: number): void;
  /** Build the OTLP ResourceMetrics payload for everything recorded so far. */
  buildMetricsPayload(serviceName: string, runId: string, timeUnixNano: string): object;
}

/** Accumulates phase telemetry into bounded-cardinality OTLP metric data points. */
export function createPhaseMetricsAggregator(): PhaseMetricsAggregator {
  return {
    recordPhase: () => {},
    recordReviewFindings: () => {},
    recordFixIterations: () => {},
    recordEscalation: () => {},
    buildMetricsPayload: () => ({ resourceMetrics: [] }),
  };
}
