import { describe, expect, test } from "bun:test";
import { newSpanId, newTraceId } from "../../../../src/plugins/builtin/otel-reporter/ids";
import {
  type SpanEvent,
  attr,
  buildMetricsPayload,
  buildTracesPayload,
  msToUnixNano,
} from "../../../../src/plugins/builtin/otel-reporter/otlp";

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
