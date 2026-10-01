import { describe, expect, test } from "bun:test";
import type {
  CounterDataPoint,
  HistogramDataPoint,
  KeyValue,
  OtlpMetric,
  OtlpMetricsPayload,
} from "@/plugins/builtin/otel-reporter/otlp";
import { attr } from "@/plugins/builtin/otel-reporter/otlp";
import {
  createPhaseMetricsAggregator,
  createSpanTree,
  PHASE_COST_BOUNDS,
  PHASE_DURATION_BOUNDS,
} from "@/plugins/builtin/otel-reporter/span-tree";
import type { PhaseCompleteEvent } from "@/plugins/types";
import { byCodePoint } from "@/utils/sort";

function makePhaseEvent(overrides: Partial<PhaseCompleteEvent> = {}): PhaseCompleteEvent {
  return {
    runId: "r1",
    scope: "story",
    storyId: "s1",
    phase: "implementer",
    outcome: "passed",
    durationMs: 4200,
    costUsd: 0.42,
    tier: "balanced",
    testStrategy: "tdd-simple",
    sessionModel: "single-session",
    ...overrides,
  };
}

// The src `OtlpMetric` types its `sum`/`histogram` members as bare `object`, so
// these two interfaces narrow the shapes span-tree.ts actually builds (verified at
// runtime by a type guard, never asserted) using the real exported point types.
interface HistogramMetric extends OtlpMetric {
  histogram: { aggregationTemporality: number; dataPoints: HistogramDataPoint[] };
}

interface SumMetric extends OtlpMetric {
  sum: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: CounterDataPoint[] };
}

function hasHistogram(metric: OtlpMetric): metric is HistogramMetric {
  return metric.histogram !== undefined;
}

function hasSum(metric: OtlpMetric): metric is SumMetric {
  return metric.sum !== undefined;
}

const FALLBACK_HISTOGRAM_POINT: HistogramDataPoint = {
  attributes: [],
  timeUnixNano: "",
  count: 0,
  sum: 0,
  bucketCounts: [],
  explicitBounds: [],
};

const FALLBACK_COUNTER_POINT: CounterDataPoint = { attributes: [], timeUnixNano: "", asInt: "0" };

// Falls back to a well-shaped but empty/zeroed data point when the payload doesn't have the
// metric yet, so assertions on an unimplemented stub fail via `expect()` rather than a thrown TypeError.
function histogramPoint(payload: OtlpMetricsPayload, name: string): HistogramDataPoint {
  const metrics = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
  const found = metrics.find((m) => m.name === name);
  if (found === undefined || !hasHistogram(found)) return FALLBACK_HISTOGRAM_POINT;
  return found.histogram.dataPoints[0] ?? FALLBACK_HISTOGRAM_POINT;
}

function counterPoint(payload: OtlpMetricsPayload, name: string): CounterDataPoint {
  const metrics = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
  const found = metrics.find((m) => m.name === name);
  if (found === undefined || !hasSum(found)) return FALLBACK_COUNTER_POINT;
  return found.sum.dataPoints[0] ?? FALLBACK_COUNTER_POINT;
}

function resourceAttributesOf(payload: OtlpMetricsPayload): KeyValue[] {
  return payload.resourceMetrics[0]?.resource?.attributes ?? [];
}

describe("createSpanTree", () => {
  test("AC2: a story span's parent equals the run span's id", () => {
    const tree = createSpanTree("trace1", "run-span");
    const span = tree.buildStorySpan("s1", "0", "1000");
    expect(span.parentSpanId).toBe("run-span");
  });

  test("AC1: a story-scope phase span's parent equals its story span's id", () => {
    const tree = createSpanTree("trace1", "run-span");
    const storySpanId = tree.storySpanId("s1");
    const event = makePhaseEvent({ scope: "story", storyId: "s1" });
    const span = tree.buildPhaseSpan({ event, traceId: "trace1", startUnixNano: "0", endUnixNano: "1000" });
    expect(span.parentSpanId).toBe(storySpanId);
  });

  test("AC3: a run-scope phase span's parent equals the run span's id", () => {
    const tree = createSpanTree("trace1", "run-span");
    const event = makePhaseEvent({ scope: "run", storyId: undefined, phase: "acceptance" });
    const span = tree.buildPhaseSpan({ event, traceId: "trace1", startUnixNano: "0", endUnixNano: "1000" });
    expect(span.parentSpanId).toBe("run-span");
  });

  test("AC11: a phase span carries a nax.test_strategy attribute equal to the event's testStrategy", () => {
    const tree = createSpanTree("trace1", "run-span");
    const event = makePhaseEvent({ testStrategy: "no-test" });
    const span = tree.buildPhaseSpan({ event, traceId: "trace1", startUnixNano: "0", endUnixNano: "1000" });
    expect(span.attributes).toContainEqual(attr("nax.test_strategy", "no-test"));
  });

  test("boundary: storySpanId returns the same id for repeated calls with the same story", () => {
    const tree = createSpanTree("trace1", "run-span");
    const first = tree.storySpanId("s1");
    const second = tree.storySpanId("s1");
    expect(first).toBe(second);
  });

  test("boundary: storySpanId returns different ids for different stories", () => {
    const tree = createSpanTree("trace1", "run-span");
    expect(tree.storySpanId("s1")).not.toBe(tree.storySpanId("s2"));
  });
});

describe("createPhaseMetricsAggregator", () => {
  test("AC4: a recorded phase event's durationMs is reflected in the nax.phase.duration histogram", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({ durationMs: 4200 }));
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000000",
    });
    const point = histogramPoint(payload, "nax.phase.duration");
    expect(point.sum).toBe(4200);
    expect(point.count).toBe(1);
  });

  test("AC5: a recorded phase event's costUsd is reflected in the nax.phase.cost_usd histogram", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({ costUsd: 0.42 }));
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000000",
    });
    const point = histogramPoint(payload, "nax.phase.cost_usd");
    expect(point.sum).toBe(0.42);
    expect(point.count).toBe(1);
  });

  test("AC8: a phase-duration data point carries no run_id or story_id attribute", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
    });
    const point = histogramPoint(payload, "nax.phase.duration");
    const keys = point.attributes.map((a) => a.key);
    expect(keys).not.toContain("run_id");
    expect(keys).not.toContain("story_id");
  });

  test("AC9: a phase-duration data point's attribute names are exactly the five aggregate dimensions", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
    });
    const point = histogramPoint(payload, "nax.phase.duration");
    const keys = point.attributes.map((a) => a.key).sort(byCodePoint);
    expect(keys).toEqual(["outcome", "phase", "session_model", "test_strategy", "tier"]);
  });

  test("AC10: phase-duration and phase-cost histograms use their respective fixed bounds", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
    });
    expect(histogramPoint(payload, "nax.phase.duration").explicitBounds).toEqual(PHASE_DURATION_BOUNDS);
    expect(histogramPoint(payload, "nax.phase.cost_usd").explicitBounds).toEqual(PHASE_COST_BOUNDS);
  });

  test("AC12: recording review findings for an adversarial-review phase exports a severity-tagged counter", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordReviewFindings("adversarial-review", "high", 3);
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
    });
    const point = counterPoint(payload, "nax.review.findings");
    expect(point.attributes).toContainEqual(attr("severity", "high"));
    expect(point.asInt).toBe("3");
  });

  test("AC13: recording fix iterations for a rectification phase exports a strategy-tagged counter", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordFixIterations("rectification", "source-fix", 2);
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
    });
    const point = counterPoint(payload, "nax.fix.iterations");
    expect(point.attributes).toContainEqual(attr("strategy", "source-fix"));
    expect(point.asInt).toBe("2");
  });

  test("AC14: recording an escalation exports a to_tier-tagged counter", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordEscalation("powerful", 1);
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
    });
    const point = counterPoint(payload, "nax.escalations");
    expect(point.attributes).toContainEqual(attr("to_tier", "powerful"));
    expect(point.asInt).toBe("1");
  });

  test("AC15: the metrics payload carries a service.name resource attribute", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "my-service",
      runId: "r1",
      timeUnixNano: "1000",
    });
    expect(resourceAttributesOf(payload)).toContainEqual(attr("service.name", "my-service"));
  });

  test("AC16: the metrics payload carries a nax.run_id resource attribute", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r42",
      timeUnixNano: "1000",
    });
    expect(resourceAttributesOf(payload)).toContainEqual(attr("nax.run_id", "r42"));
  });

  test("boundary: multiple recorded phases of the same dimensions accumulate into one histogram", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({ durationMs: 100 }));
    agg.recordPhase(makePhaseEvent({ durationMs: 200 }));
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
    });
    const point = histogramPoint(payload, "nax.phase.duration");
    expect(point.count).toBe(2);
    expect(point.sum).toBe(300);
  });

  test("boundary: an aggregator with nothing recorded still exports a resource-attributed payload with no metrics", () => {
    const agg = createPhaseMetricsAggregator();
    const payload: OtlpMetricsPayload = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
    });
    expect(payload.resourceMetrics[0].scopeMetrics[0].metrics).toEqual([]);
    expect(resourceAttributesOf(payload)).toContainEqual(attr("service.name", "nax"));
    expect(resourceAttributesOf(payload)).toContainEqual(attr("nax.run_id", "r1"));
  });
});
