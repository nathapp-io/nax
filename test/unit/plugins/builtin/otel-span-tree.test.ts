import { describe, expect, test } from "bun:test";
import type { PhaseCompleteEvent } from "@/plugins/types";
import { attr } from "../../../../src/plugins/builtin/otel-reporter/otlp";
import {
  PHASE_COST_BOUNDS,
  PHASE_DURATION_BOUNDS,
  createPhaseMetricsAggregator,
  createSpanTree,
} from "../../../../src/plugins/builtin/otel-reporter/span-tree";

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

// Falls back to a well-shaped but empty/zeroed metric when the payload doesn't have one yet,
// so assertions on an unimplemented stub fail via `expect()` rather than a thrown TypeError.
// biome-ignore lint/suspicious/noExplicitAny: traversing a dynamic OTLP metrics payload
function findMetric(payload: any, name: string) {
  const metrics = payload?.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics ?? [];
  return (
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP metric entry
    metrics.find((m: any) => m.name === name) ?? {
      name,
      histogram: { dataPoints: [{ attributes: [], sum: 0, count: 0, explicitBounds: [] }] },
      sum: { dataPoints: [{ attributes: [], asInt: "0" }] },
    }
  );
}

// biome-ignore lint/suspicious/noExplicitAny: traversing a dynamic OTLP metrics payload
function resourceAttributesOf(payload: any) {
  return payload?.resourceMetrics?.[0]?.resource?.attributes ?? [];
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
    const event = makePhaseEvent({ testStrategy: "greenfield" });
    const span = tree.buildPhaseSpan({ event, traceId: "trace1", startUnixNano: "0", endUnixNano: "1000" });
    expect(span.attributes).toContainEqual(attr("nax.test_strategy", "greenfield"));
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
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000000" });
    const point = findMetric(payload, "nax.phase.duration").histogram.dataPoints[0];
    expect(point.sum).toBe(4200);
    expect(point.count).toBe(1);
  });

  test("AC5: a recorded phase event's costUsd is reflected in the nax.phase.cost_usd histogram", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({ costUsd: 0.42 }));
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000000" });
    const point = findMetric(payload, "nax.phase.cost_usd").histogram.dataPoints[0];
    expect(point.sum).toBe(0.42);
    expect(point.count).toBe(1);
  });

  test("AC8: a phase-duration data point carries no run_id or story_id attribute", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000" });
    const point = findMetric(payload, "nax.phase.duration").histogram.dataPoints[0];
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP attribute entries
    const keys = point.attributes.map((a: any) => a.key);
    expect(keys).not.toContain("run_id");
    expect(keys).not.toContain("story_id");
  });

  test("AC9: a phase-duration data point's attribute names are exactly the five aggregate dimensions", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000" });
    const point = findMetric(payload, "nax.phase.duration").histogram.dataPoints[0];
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP attribute entries
    const keys = point.attributes.map((a: any) => a.key).sort();
    expect(keys).toEqual(["outcome", "phase", "session_model", "test_strategy", "tier"]);
  });

  test("AC10: phase-duration and phase-cost histograms use their respective fixed bounds", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000" });
    expect(findMetric(payload, "nax.phase.duration").histogram.dataPoints[0].explicitBounds).toEqual(
      PHASE_DURATION_BOUNDS,
    );
    expect(findMetric(payload, "nax.phase.cost_usd").histogram.dataPoints[0].explicitBounds).toEqual(PHASE_COST_BOUNDS);
  });

  test("AC12: recording review findings for an adversarial-review phase exports a severity-tagged counter", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordReviewFindings("adversarial-review", "high", 3);
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000" });
    const point = findMetric(payload, "nax.review.findings").sum.dataPoints[0];
    expect(point.attributes).toContainEqual(attr("severity", "high"));
    expect(point.asInt).toBe("3");
  });

  test("AC13: recording fix iterations for a rectification phase exports a strategy-tagged counter", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordFixIterations("rectification", "source-fix", 2);
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000" });
    const point = findMetric(payload, "nax.fix.iterations").sum.dataPoints[0];
    expect(point.attributes).toContainEqual(attr("strategy", "source-fix"));
    expect(point.asInt).toBe("2");
  });

  test("AC14: recording an escalation exports a to_tier-tagged counter", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordEscalation("powerful", 1);
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000" });
    const point = findMetric(payload, "nax.escalations").sum.dataPoints[0];
    expect(point.attributes).toContainEqual(attr("to_tier", "powerful"));
    expect(point.asInt).toBe("1");
  });

  test("AC15: the metrics payload carries a service.name resource attribute", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "my-service", runId: "r1", timeUnixNano: "1000" });
    expect(resourceAttributesOf(payload)).toContainEqual(attr("service.name", "my-service"));
  });

  test("AC16: the metrics payload carries a nax.run_id resource attribute", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({}));
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r42", timeUnixNano: "1000" });
    expect(resourceAttributesOf(payload)).toContainEqual(attr("nax.run_id", "r42"));
  });

  test("boundary: multiple recorded phases of the same dimensions accumulate into one histogram", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase(makePhaseEvent({ durationMs: 100 }));
    agg.recordPhase(makePhaseEvent({ durationMs: 200 }));
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000" });
    const point = findMetric(payload, "nax.phase.duration").histogram.dataPoints[0];
    expect(point.count).toBe(2);
    expect(point.sum).toBe(300);
  });

  test("boundary: an aggregator with nothing recorded still exports a resource-attributed payload with no metrics", () => {
    const agg = createPhaseMetricsAggregator();
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({ serviceName: "nax", runId: "r1", timeUnixNano: "1000" });
    expect(payload.resourceMetrics[0].scopeMetrics[0].metrics).toEqual([]);
    expect(resourceAttributesOf(payload)).toContainEqual(attr("service.name", "nax"));
    expect(resourceAttributesOf(payload)).toContainEqual(attr("nax.run_id", "r1"));
  });
});
