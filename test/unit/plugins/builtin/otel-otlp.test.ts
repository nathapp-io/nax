import { describe, expect, test } from "bun:test";
import { newSpanId, newTraceId } from "../../../../src/plugins/builtin/otel-reporter/ids";
import {
  type SpanEvent,
  attr,
  buildCounterPoint,
  buildHistogramPoint,
  buildMetricsPayload,
  buildResourceAttributes,
  buildTracesPayload,
  msToUnixNano,
} from "../../../../src/plugins/builtin/otel-reporter/otlp";
import { PHASE_DURATION_BOUNDS } from "../../../../src/plugins/builtin/otel-reporter/span-tree";

describe("ids", () => {
  test("newTraceId is 32 lowercase hex chars", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
  test("newSpanId is 16 lowercase hex chars", () => {
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("msToUnixNano", () => {
  test("converts milliseconds to nanosecond string", () => {
    expect(msToUnixNano(1500)).toBe("1500000000");
  });
});

describe("attr", () => {
  test("maps strings to stringValue and numbers to doubleValue", () => {
    expect(attr("k", "v")).toEqual({ key: "k", value: { stringValue: "v" } });
    expect(attr("n", 3.5)).toEqual({ key: "n", value: { doubleValue: 3.5 } });
  });
});

const summary = { completed: 2, failed: 1, skipped: 0, paused: 0 };
const events: SpanEvent[] = [{ timeUnixNano: "1000000", name: "story.complete", attributes: [attr("storyId", "s1")] }];

describe("buildTracesPayload", () => {
  // biome-ignore lint/suspicious/noExplicitAny: testing dynamic OTLP payload
  const payload: any = buildTracesPayload({
    serviceName: "nax",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    startUnixNano: "1000",
    endUnixNano: "2000",
    feature: "feat",
    runId: "r1",
    storySummary: summary,
    totalCost: 0.42,
    events,
  });

  test("nests one resource span with service.name resource attr", () => {
    const rs = payload.resourceSpans[0];
    expect(rs.resource.attributes).toContainEqual(attr("service.name", "nax"));
  });

  test("root span carries ids, timing, run attrs, and buffered events", () => {
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe("a".repeat(32));
    expect(span.spanId).toBe("b".repeat(16));
    expect(span.name).toBe("nax.run");
    expect(span.startTimeUnixNano).toBe("1000");
    expect(span.endTimeUnixNano).toBe("2000");
    expect(span.attributes).toContainEqual(attr("feature", "feat"));
    expect(span.attributes).toContainEqual(attr("runId", "r1"));
    expect(span.events).toEqual(events);
  });

  test("status code is ERROR (2) when any story failed", () => {
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.status).toEqual({ code: 2 });
  });

  test("status code is OK (1) when nothing failed", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing dynamic OTLP payload
    const ok: any = buildTracesPayload({
      serviceName: "nax",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startUnixNano: "1000",
      endUnixNano: "2000",
      feature: "f",
      runId: "r",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      totalCost: 0,
      events: [],
    });
    expect(ok.resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({ code: 1 });
  });

  test("US-008: extraSpans are appended to scopeSpans[0].spans after the root span", () => {
    const extraSpans = [
      { traceId: "a".repeat(32), spanId: "c".repeat(16), name: "nax.phase", attributes: [] },
      { traceId: "a".repeat(32), spanId: "d".repeat(16), name: "nax.phase", attributes: [] },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: testing dynamic OTLP payload
    const withExtras: any = buildTracesPayload({
      serviceName: "nax",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startUnixNano: "1000",
      endUnixNano: "2000",
      feature: "feat",
      runId: "r1",
      storySummary: summary,
      totalCost: 0.42,
      events,
      extraSpans,
    });

    const spans = withExtras.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(3);
    expect(spans[0].name).toBe("nax.run"); // root span stays first
    expect(spans[0].spanId).toBe("b".repeat(16));
    expect(spans.slice(1)).toEqual(extraSpans);
  });

  test("US-008 boundary: an omitted extraSpans yields only the root span", () => {
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("nax.run");
  });
});

describe("buildMetricsPayload", () => {
  // biome-ignore lint/suspicious/noExplicitAny: testing dynamic OTLP payload
  const payload: any = buildMetricsPayload({
    serviceName: "nax",
    runId: "r1",
    timeUnixNano: "2000",
    storySummary: summary,
    totalCost: 0.42,
    totalDurationMs: 1234,
  });
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  // biome-ignore lint/suspicious/noExplicitAny: accessing untyped metric entries
  const byName = (n: string) => metrics.find((m: any) => m.name === n);

  test("emits a stories.total counter with one data point per non-zero status", () => {
    const sum = byName("nax.stories.total").sum;
    expect(sum.isMonotonic).toBe(true);
    expect(sum.aggregationTemporality).toBe(2);
    // biome-ignore lint/suspicious/noExplicitAny: accessing untyped dataPoint entries
    const statuses = sum.dataPoints.map((d: any) => d.attributes[0].value.stringValue).sort();
    expect(statuses).toEqual(["completed", "failed"]);
    // biome-ignore lint/suspicious/noExplicitAny: accessing untyped dataPoint entries
    const completed = sum.dataPoints.find((d: any) => d.attributes[0].value.stringValue === "completed");
    expect(completed.asInt).toBe("2");
  });

  test("emits run.cost and run.duration_ms gauges", () => {
    expect(byName("nax.run.cost").gauge.dataPoints[0].asDouble).toBe(0.42);
    expect(byName("nax.run.duration_ms").gauge.dataPoints[0].asDouble).toBe(1234);
  });
});

describe("buildHistogramPoint", () => {
  test("AC6: bucket-count list has exactly one more entry than the explicit-bounds list", () => {
    const point = buildHistogramPoint([50, 600, 20_000], PHASE_DURATION_BOUNDS, [], "0");
    expect(point.bucketCounts).toHaveLength(point.explicitBounds.length + 1);
  });

  test("AC7: sum equals the total of the values recorded into it", () => {
    const point = buildHistogramPoint([1, 2, 3.5], [1, 2, 3], [], "0");
    expect(point.sum).toBe(6.5);
  });

  test("boundary: no values yields a zeroed histogram of the correct shape", () => {
    const point = buildHistogramPoint([], [1, 2, 3], [], "0");
    expect(point.count).toBe(0);
    expect(point.sum).toBe(0);
    expect(point.bucketCounts).toEqual([0, 0, 0, 0]);
  });
});

describe("buildCounterPoint", () => {
  test("carries the given attributes and count", () => {
    const point = buildCounterPoint(3, [attr("severity", "high")], "1000");
    expect(point.attributes).toContainEqual(attr("severity", "high"));
    expect(point.asInt).toBe("3");
  });

  test("boundary: a zero count still produces a valid data point", () => {
    const point = buildCounterPoint(0, [], "1000");
    expect(point.asInt).toBe("0");
  });
});

describe("buildResourceAttributes", () => {
  test("AC15: includes a service.name attribute equal to the configured service name", () => {
    expect(buildResourceAttributes("my-service", "r1")).toContainEqual(attr("service.name", "my-service"));
  });

  test("AC16: includes a nax.run_id attribute equal to the current run's id", () => {
    expect(buildResourceAttributes("nax", "r42")).toContainEqual(attr("nax.run_id", "r42"));
  });
});
