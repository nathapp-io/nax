import { hostname } from "node:os";
import { NAX_VERSION } from "@/version";

/** OTLP/JSON attribute value (subset — string and double only). */
export interface KeyValue {
  key: string;
  value: { stringValue?: string; doubleValue?: number };
}

/** OTLP/JSON span event. */
export interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: KeyValue[];
}

export type StorySummary = {
  completed: number;
  failed: number;
  skipped: number;
  paused: number;
};

/** Build an OTLP attribute. Strings -> stringValue; numbers -> doubleValue. */
export function attr(key: string, value: string | number): KeyValue {
  return typeof value === "number" ? { key, value: { doubleValue: value } } : { key, value: { stringValue: value } };
}

/** Convert milliseconds to an OTLP nanosecond timestamp string. */
export function msToUnixNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

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
  const bucketCounts = new Array(bounds.length + 1).fill(0);
  let sum = 0;
  for (const value of values) {
    sum += value;
    const bucketIndex = bounds.findIndex((bound) => value <= bound);
    bucketCounts[bucketIndex === -1 ? bounds.length : bucketIndex]++;
  }
  return { attributes, timeUnixNano, count: values.length, sum, bucketCounts, explicitBounds: bounds };
}

export interface CounterDataPoint {
  attributes: KeyValue[];
  timeUnixNano: string;
  asInt: string;
}

/** Build an OTLP monotonic-sum (counter) data point. */
export function buildCounterPoint(count: number, attributes: KeyValue[], timeUnixNano: string): CounterDataPoint {
  return { attributes, timeUnixNano, asInt: String(count) };
}

export interface ResourceAttributesInput {
  serviceName: string;
  runId: string;
  feature?: string;
  project?: string;
  git?: { branch?: string; sha?: string };
}

/** Resource attributes shared by every OTLP payload this reporter exports. */
export function buildResourceAttributes(input: ResourceAttributesInput): KeyValue[] {
  const attrs: KeyValue[] = [
    attr("service.name", input.serviceName),
    attr("nax.run_id", input.runId),
    attr("nax.version", NAX_VERSION),
    attr("process.pid", process.pid),
  ];
  try {
    attrs.push(attr("host.name", hostname()));
  } catch {
    // best-effort: omit host.name when hostname() throws (e.g. restricted environments)
  }
  if (input.feature !== undefined) attrs.push(attr("nax.feature", input.feature));
  if (input.project !== undefined) attrs.push(attr("nax.project", input.project));
  if (input.git?.branch !== undefined) attrs.push(attr("nax.git.branch", input.git.branch));
  if (input.git?.sha !== undefined) attrs.push(attr("nax.git.sha", input.git.sha));
  return attrs;
}

export interface TracesInput {
  serviceName: string;
  traceId: string;
  spanId: string;
  /** W3C-adopted parent span id — omitted when no valid TRACEPARENT was present. */
  parentSpanId?: string;
  startUnixNano: string;
  endUnixNano: string;
  feature: string;
  runId: string;
  storySummary: StorySummary;
  totalCost: number;
  events: SpanEvent[];
  /** Additional spans (e.g. phase spans) appended after the root span (US-008). */
  extraSpans?: object[];
}

/** Build an OTLP/HTTP-JSON ResourceSpans payload with one root `nax.run` span. */
export function buildTracesPayload(p: TracesInput): object {
  const span = {
    traceId: p.traceId,
    spanId: p.spanId,
    ...(p.parentSpanId ? { parentSpanId: p.parentSpanId } : {}),
    name: "nax.run",
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: p.startUnixNano,
    endTimeUnixNano: p.endUnixNano,
    attributes: [
      attr("feature", p.feature),
      attr("runId", p.runId),
      attr("stories.completed", p.storySummary.completed),
      attr("stories.failed", p.storySummary.failed),
      attr("stories.skipped", p.storySummary.skipped),
      attr("stories.paused", p.storySummary.paused),
      attr("cost.total", p.totalCost),
    ],
    events: p.events,
    status: { code: p.storySummary.failed > 0 ? 2 : 1 }, // 2=ERROR, 1=OK
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", p.serviceName)] },
        scopeSpans: [{ scope: { name: "nax" }, spans: [span, ...(p.extraSpans ?? [])] }],
      },
    ],
  };
}

export interface MetricsInput {
  serviceName: string;
  runId: string;
  timeUnixNano: string;
  storySummary: StorySummary;
  totalCost: number;
  totalDurationMs: number;
}

/** Build an OTLP/HTTP-JSON ResourceMetrics payload (stories counter + gauges). */
export function buildMetricsPayload(p: MetricsInput): object {
  const statusEntries = Object.entries(p.storySummary).filter(([, n]) => n > 0);
  const storiesSum = {
    name: "nax.stories.total",
    sum: {
      aggregationTemporality: 2, // CUMULATIVE
      isMonotonic: true,
      dataPoints: statusEntries.map(([status, count]) => ({
        asInt: String(count),
        timeUnixNano: p.timeUnixNano,
        attributes: [attr("status", status)],
      })),
    },
  };
  const gauge = (name: string, value: number) => ({
    name,
    gauge: { dataPoints: [{ asDouble: value, timeUnixNano: p.timeUnixNano }] },
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: [attr("service.name", p.serviceName)] },
        scopeMetrics: [
          {
            scope: { name: "nax" },
            metrics: [storiesSum, gauge("nax.run.cost", p.totalCost), gauge("nax.run.duration_ms", p.totalDurationMs)],
          },
        ],
      },
    ],
  };
}
