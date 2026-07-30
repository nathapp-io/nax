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
        scopeSpans: [{ scope: { name: "nax" }, spans: [span] }],
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
