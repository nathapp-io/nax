import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockFetch } from "@test/helpers";
import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { createOtelReporterPlugin, type PostJsonDeps } from "@/plugins";
import type {
  CounterDataPoint,
  HistogramDataPoint,
  KeyValue,
  OtlpMetric,
  OtlpMetricsPayload,
  OtlpTracesPayload,
  SpanEvent,
} from "@/plugins/builtin/otel-reporter/otlp";

// src keeps span arrays (`object[]`) and `OtlpMetric.sum`/`.histogram` (bare
// `object`) vague, so these narrow the shapes the reporter actually exports —
// verified at runtime by type guards, never asserted (otel-span-tree pattern).
type CapturedBody = OtlpTracesPayload | OtlpMetricsPayload;

interface ExportedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes: KeyValue[];
  events: SpanEvent[];
  status?: { code: number };
}

interface HistogramMetric extends OtlpMetric {
  histogram: { aggregationTemporality: number; dataPoints: HistogramDataPoint[] };
}

interface SumMetric extends OtlpMetric {
  sum: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: CounterDataPoint[] };
}

function isExportedSpan(v: object): v is ExportedSpan {
  return "traceId" in v && "spanId" in v && "name" in v;
}

function hasHistogram(metric: OtlpMetric): metric is HistogramMetric {
  return metric.histogram !== undefined;
}

function hasSum(metric: OtlpMetric): metric is SumMetric {
  return metric.sum !== undefined;
}

function tracesPayload(body: CapturedBody): OtlpTracesPayload {
  if (!("resourceSpans" in body)) throw new Error("expected a /v1/traces payload");
  return body;
}

function metricsPayload(body: CapturedBody): OtlpMetricsPayload {
  if (!("resourceMetrics" in body)) throw new Error("expected a /v1/metrics payload");
  return body;
}

function spansOf(payload: OtlpTracesPayload): ExportedSpan[] {
  const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  return spans.map((span) => {
    if (!isExportedSpan(span)) throw new Error("unexpected span shape in traces payload");
    return span;
  });
}

function metricsOf(payload: OtlpMetricsPayload): OtlpMetric[] {
  return payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
}

const cfg: OtelReporterConfig = {
  enabled: true,
  endpoint: "https://otlp.example.com/",
  headers: {},
  serviceName: "nax",
  timeoutMs: 1000,
  detail: "counts",
  heartbeatIntervalMs: 0,
  maxBatchSize: 64,
  flushIntervalMs: 5_000,
  maxQueueSize: 2_048,
  logs: { enabled: false, level: "info" },
};

// Fully-populated config (mirrors what the zod schema fills in via .default()) —
// used by the batch-queue / traceparent tests below so nothing relies on an
// implementer supplying its own fallback for the new queue-related fields.
const fullCfg: OtelReporterConfig = {
  ...cfg,
  detail: "counts",
  heartbeatIntervalMs: 10_000,
  maxBatchSize: 64,
  flushIntervalMs: 5_000,
  maxQueueSize: 2_048,
};

function capturing() {
  const posts: Array<{ url: string; body: CapturedBody }> = [];
  const deps: PostJsonDeps = {
    fetch: mockFetch(async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    }),
  };
  return { posts, deps };
}

function reporterOf(plugin: ReturnType<typeof createOtelReporterPlugin>) {
  const reporter = plugin.extensions.reporter;
  if (reporter === undefined) throw new Error("otel-reporter did not declare a reporter extension");
  return reporter;
}

async function runOnce(plugin: ReturnType<typeof createOtelReporterPlugin>) {
  const r = reporterOf(plugin);
  await r.onRunStart?.({ runId: "r1", feature: "f", totalStories: 2, startTime: "1970-01-01T00:00:00.000Z" });
  await r.onStoryComplete?.({
    runId: "r1",
    storyId: "s1",
    status: "completed",
    runElapsedMs: 100,
    cost: 0.1,
    tier: "fast",
    testStrategy: "tdd-simple",
  });
  await r.onStoryComplete?.({
    runId: "r1",
    storyId: "s2",
    status: "failed",
    runElapsedMs: 200,
    cost: 0.2,
    tier: "balanced",
    testStrategy: "tdd-simple",
  });
  await r.onRunEnd?.({
    runId: "r1",
    totalDurationMs: 300,
    totalCost: 0.3,
    storySummary: { completed: 1, failed: 1, skipped: 0, paused: 0 },
  });
}

describe("otel-reporter", () => {
  test("declares the reporter extension point", () => {
    const plugin = createOtelReporterPlugin(cfg);
    expect(plugin.name).toBe("otel-reporter");
    expect(plugin.provides).toContain("reporter");
  });

  test("POSTs traces then metrics to the normalized endpoints at run end", async () => {
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(cfg, deps));
    expect(posts.map((p) => p.url)).toEqual([
      "https://otlp.example.com/v1/traces",
      "https://otlp.example.com/v1/metrics",
    ]);
  });

  test("buffers story completions as span events on the root span", async () => {
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(cfg, deps));
    const span = spansOf(tracesPayload(posts[0].body))[0];
    expect(span.events).toHaveLength(2);
    expect(span.events[0].name).toBe("story.complete");
    // startMs (epoch 0, from onRunStart's startTime) + runElapsedMs(100) -> 100ms -> 100_000_000 ns
    expect(span.events[0].timeUnixNano).toBe("100000000");
    expect(span.status?.code).toBe(2); // one failed
    expect(span.attributes).toContainEqual({ key: "feature", value: { stringValue: "f" } });
  });

  test("emits no story events before onRunStart is dropped (no state)", async () => {
    const { posts, deps } = capturing();
    const r = reporterOf(createOtelReporterPlugin(cfg, deps));
    // onStoryComplete with no prior onRunStart is a no-op, not a throw
    await r.onStoryComplete?.({
      runId: "x",
      storyId: "s",
      status: "completed",
      runElapsedMs: 5,
      cost: 0,
      tier: "fast",
      testStrategy: "tdd-simple",
    });
    expect(posts).toHaveLength(0);
  });

  test("onRunEnd without a prior onRunStart still flushes a best-effort span", async () => {
    const { posts, deps } = capturing();
    const r = reporterOf(createOtelReporterPlugin(cfg, deps));
    await r.onRunEnd?.({
      runId: "orphan",
      totalDurationMs: 300,
      totalCost: 0.3,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });
    expect(posts).toHaveLength(2);
    const span = spansOf(tracesPayload(posts[0].body))[0];
    expect(span.events).toEqual([]);
    expect(span.status?.code).toBe(1);
  });

  test("deletes run state after onRunEnd (second onRunEnd is inert best-effort)", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(cfg, deps);
    await runOnce(plugin);
    const afterFirst = posts.length;
    // A stray late story event for the same run must not append to a live buffer.
    await plugin.extensions.reporter?.onStoryComplete?.({
      runId: "r1",
      storyId: "s3",
      status: "completed",
      runElapsedMs: 400,
      cost: 0,
      tier: "fast",
      testStrategy: "tdd-simple",
    });
    expect(posts.length).toBe(afterFirst); // no new POST; state gone
  });

  test("skips both POSTs when a required env var is missing", async () => {
    const { posts, deps } = capturing();
    delete process.env.OTLP_TOKEN;
    const plugin = createOtelReporterPlugin({ ...cfg, headers: { Authorization: `Bearer \${OTLP_TOKEN}` } }, deps);
    await runOnce(plugin);
    expect(posts).toHaveLength(0);
  });

  test("does nothing when endpoint is unset", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(
      {
        enabled: true,
        headers: {},
        serviceName: "nax",
        timeoutMs: 1000,
        detail: "counts",
        heartbeatIntervalMs: 0,
        maxBatchSize: 64,
        flushIntervalMs: 5_000,
        maxQueueSize: 2_048,
        logs: { enabled: false, level: "info" },
      },
      deps,
    );
    await runOnce(plugin);
    expect(posts).toHaveLength(0);
  });

  test("AC1: a run whose stories all complete still exports a run span carrying the run's total cost", async () => {
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    const tracesPost = posts.find((p) => p.url.endsWith("/v1/traces"));
    expect(tracesPost).toBeDefined();
    if (tracesPost === undefined) throw new Error("no /v1/traces POST captured");
    const span = spansOf(tracesPayload(tracesPost.body))[0];
    expect(span.attributes).toContainEqual({ key: "cost.total", value: { doubleValue: 0.3 } });
  });

  // SEAM-5: buildHistogramPoint must actually be reached by a completed phase,
  // not merely unit-tested in isolation (US-007).
  test("SEAM-5: a completed phase produces an exported nax.phase.duration data point matching the event's durationMs", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(fullCfg, deps);
    const r = reporterOf(plugin);

    await r.onRunStart?.({ runId: "seam5", feature: "f", totalStories: 1, startTime: new Date().toISOString() });
    await r.onPhaseComplete?.({
      runId: "seam5",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 1234,
      costUsd: 0.05,
      tier: "fast",
      testStrategy: "tdd-simple",
      sessionModel: "single-session",
    });
    await r.onRunEnd?.({
      runId: "seam5",
      totalDurationMs: 2000,
      totalCost: 0.05,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });

    const metricsPost = posts.find((p) => p.url.endsWith("/v1/metrics"));
    if (metricsPost === undefined) throw new Error("no /v1/metrics POST captured");
    const durationMetric = metricsOf(metricsPayload(metricsPost.body)).find((m) => m.name === "nax.phase.duration");
    expect(durationMetric).toBeDefined();
    if (durationMetric === undefined || !hasHistogram(durationMetric)) {
      throw new Error("nax.phase.duration histogram missing from metrics payload");
    }
    const point = durationMetric.histogram.dataPoints[0];
    expect(point.sum).toBe(1234);
    expect(point.count).toBe(1);
  });

  test("a story:escalated event reaches the reporter's onEscalation hook and produces an exported nax.escalations counter", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(fullCfg, deps);
    const r = reporterOf(plugin);

    await r.onRunStart?.({ runId: "esc1", feature: "f", totalStories: 1, startTime: new Date().toISOString() });
    await r.onEscalation?.({ runId: "esc1", storyId: "s1", fromTier: "fast", toTier: "powerful" });
    await r.onRunEnd?.({
      runId: "esc1",
      totalDurationMs: 100,
      totalCost: 0,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });

    const metricsPost = posts.find((p) => p.url.endsWith("/v1/metrics"));
    if (metricsPost === undefined) throw new Error("no /v1/metrics POST captured");
    const escalations = metricsOf(metricsPayload(metricsPost.body)).find((m) => m.name === "nax.escalations");
    expect(escalations).toBeDefined();
    if (escalations === undefined || !hasSum(escalations)) {
      throw new Error("nax.escalations sum missing from metrics payload");
    }
    expect(escalations.sum.dataPoints[0].asInt).toBe("1");
  });

  test("a story with completed phases exports a nax.story span parented to the run span, and its phase span is parented to the story span", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(fullCfg, deps);
    const r = reporterOf(plugin);

    await r.onRunStart?.({ runId: "story1", feature: "f", totalStories: 1, startTime: new Date().toISOString() });
    await r.onPhaseComplete?.({
      runId: "story1",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 10,
      costUsd: 0.01,
    });
    await r.onStoryComplete?.({
      runId: "story1",
      storyId: "s1",
      status: "completed",
      runElapsedMs: 50,
      cost: 0.01,
      tier: "fast",
      testStrategy: "tdd-simple",
    });
    await r.onRunEnd?.({
      runId: "story1",
      totalDurationMs: 100,
      totalCost: 0.01,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });

    const allSpans = posts.filter((p) => p.url.endsWith("/v1/traces")).flatMap((p) => spansOf(tracesPayload(p.body)));
    const runSpan = allSpans.find((s) => s.name === "nax.run");
    const storySpan = allSpans.find((s) => s.name === "nax.story");
    const phaseSpan = allSpans.find((s) => s.name === "nax.phase");

    expect(runSpan).toBeDefined();
    expect(storySpan).toBeDefined();
    expect(storySpan?.parentSpanId).toBe(runSpan?.spanId);
    expect(phaseSpan).toBeDefined();
    expect(phaseSpan?.parentSpanId).toBe(storySpan?.spanId);
  });
});

describe("otel-reporter traceparent adoption", () => {
  let originalTraceparent: string | undefined;

  beforeEach(() => {
    originalTraceparent = process.env.TRACEPARENT;
  });

  afterEach(() => {
    if (originalTraceparent === undefined) delete process.env.TRACEPARENT;
    else process.env.TRACEPARENT = originalTraceparent;
  });

  function runSpanOf(posts: Array<{ url: string; body: CapturedBody }>): ExportedSpan | undefined {
    const tracesPost = posts.find((p) => p.url.endsWith("/v1/traces"));
    if (tracesPost === undefined) return undefined;
    return spansOf(tracesPayload(tracesPost.body))[0];
  }

  test("AC12: a valid W3C traceparent produces a run span whose parent span id equals its span id", async () => {
    process.env.TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    expect(runSpanOf(posts)?.parentSpanId).toBe("b7ad6b7169203331");
  });

  test("AC13: a malformed traceparent produces a run span with no parent span id", async () => {
    process.env.TRACEPARENT = "invalid";
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    const span = runSpanOf(posts);
    expect(span).toBeDefined();
    expect(span?.parentSpanId).toBeUndefined();
  });

  test("AC14: a traceparent whose trace id is all zeros produces a run span with no parent span id", async () => {
    process.env.TRACEPARENT = "00-00000000000000000000000000000000-b7ad6b7169203331-01";
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    const span = runSpanOf(posts);
    expect(span).toBeDefined();
    expect(span?.parentSpanId).toBeUndefined();
  });

  test("boundary: no TRACEPARENT env var produces a run span with no parent span id", async () => {
    delete process.env.TRACEPARENT;
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    const span = runSpanOf(posts);
    expect(span).toBeDefined();
    expect(span?.parentSpanId).toBeUndefined();
  });
});
