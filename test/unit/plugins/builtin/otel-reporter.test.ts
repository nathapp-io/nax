import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { type PostJsonDeps, createOtelReporterPlugin } from "@/plugins";

const cfg: OtelReporterConfig = {
  enabled: true,
  endpoint: "https://otlp.example.com/",
  headers: {},
  serviceName: "nax",
  timeoutMs: 1000,
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
  const posts: Array<{ url: string; body: any }> = [];
  const deps: PostJsonDeps = {
    fetch: async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    },
  };
  return { posts, deps };
}

async function runOnce(plugin: ReturnType<typeof createOtelReporterPlugin>) {
  const r = plugin.extensions.reporter!;
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
    const span = posts[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.events).toHaveLength(2);
    expect(span.events[0].name).toBe("story.complete");
    // startMs (epoch 0, from onRunStart's startTime) + runElapsedMs(100) -> 100ms -> 100_000_000 ns
    expect(span.events[0].timeUnixNano).toBe("100000000");
    expect(span.status.code).toBe(2); // one failed
    expect(span.attributes).toContainEqual({ key: "feature", value: { stringValue: "f" } });
  });

  test("emits no story events before onRunStart is dropped (no state)", async () => {
    const { posts, deps } = capturing();
    const r = createOtelReporterPlugin(cfg, deps).extensions.reporter!;
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
    const r = createOtelReporterPlugin(cfg, deps).extensions.reporter!;
    await r.onRunEnd?.({
      runId: "orphan",
      totalDurationMs: 300,
      totalCost: 0.3,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });
    expect(posts).toHaveLength(2);
    const span = posts[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.events).toEqual([]);
    expect(span.status.code).toBe(1);
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
    const plugin = createOtelReporterPlugin({ ...cfg, headers: { Authorization: "Bearer ${OTLP_TOKEN}" } }, deps);
    await runOnce(plugin);
    expect(posts).toHaveLength(0);
  });

  test("does nothing when endpoint is unset", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin({ enabled: true, headers: {}, serviceName: "nax", timeoutMs: 1000 }, deps);
    await runOnce(plugin);
    expect(posts).toHaveLength(0);
  });

  test("AC1: a run whose stories all complete still exports a run span carrying the run's total cost", async () => {
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    const tracesPost = posts.find((p) => p.url.endsWith("/v1/traces"));
    expect(tracesPost).toBeDefined();
    const span = tracesPost?.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes).toContainEqual({ key: "cost.total", value: { doubleValue: 0.3 } });
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

  function runSpanOf(posts: Array<{ url: string; body: any }>) {
    const tracesPost = posts.find((p) => p.url.endsWith("/v1/traces"));
    return tracesPost?.body.resourceSpans[0].scopeSpans[0].spans[0];
  }

  test("AC12: a valid W3C traceparent produces a run span whose parent span id equals its span id", async () => {
    process.env.TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    expect(runSpanOf(posts).parentSpanId).toBe("b7ad6b7169203331");
  });

  test("AC13: a malformed traceparent produces a run span with no parent span id", async () => {
    process.env.TRACEPARENT = "invalid";
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    expect(runSpanOf(posts).parentSpanId).toBeUndefined();
  });

  test("AC14: a traceparent whose trace id is all zeros produces a run span with no parent span id", async () => {
    process.env.TRACEPARENT = "00-00000000000000000000000000000000-b7ad6b7169203331-01";
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    expect(runSpanOf(posts).parentSpanId).toBeUndefined();
  });

  test("boundary: no TRACEPARENT env var produces a run span with no parent span id", async () => {
    delete process.env.TRACEPARENT;
    const { posts, deps } = capturing();
    await runOnce(createOtelReporterPlugin(fullCfg, deps));

    expect(runSpanOf(posts).parentSpanId).toBeUndefined();
  });
});
