/**
 * Resource attribute adoption tests (US-007).
 *
 * Verifies that every OTLP payload path uses `buildResourceAttributes` so
 * shared identity fields (nax.feature, nax.project, nax.run_id, nax.git.*) flow
 * to the wire. Heartbeat datapoint attributes stay bare so existing dashboard
 * queries continue to match.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { createOtelReporterPlugin } from "@/plugins";
import type { PostJsonDeps } from "@/plugins/builtin/reporter-shared";
import {
  type Heartbeat,
  type HeartbeatSnapshot,
  buildHeartbeatMetricsPayload,
  startHeartbeat,
} from "../../../../src/plugins/builtin/otel-reporter/heartbeat";
import {
  buildMetricsPayload,
  buildResourceAttributes,
  buildTracesPayload,
} from "../../../../src/plugins/builtin/otel-reporter/otlp";
import {
  createPhaseMetricsAggregator,
  createSpanTree,
} from "../../../../src/plugins/builtin/otel-reporter/span-tree";

const liveHeartbeats: Heartbeat[] = [];
function track(hb: Heartbeat): Heartbeat {
  liveHeartbeats.push(hb);
  return hb;
}
afterEach(() => {
  for (const hb of liveHeartbeats.splice(0)) hb.stop();
});

function snapshot(overrides: Partial<HeartbeatSnapshot> = {}): HeartbeatSnapshot {
  return {
    attributes: {
      runId: "r1",
      feature: "feat-1",
      project: "proj-1",
      storyId: "s1",
      phase: "implementer",
      tier: "balanced",
      testStrategy: "tdd-simple",
    },
    phaseElapsedMs: 0,
    costUsd: 0,
    ...overrides,
  };
}

function capturingDeps(): PostJsonDeps {
  return {
    fetch: async (_url, _init) => new Response(null, { status: 200 }),
  };
}

function capturingPosts() {
  const posts: Array<{ url: string; body: any }> = [];
  const deps: PostJsonDeps = {
    fetch: async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    },
  };
  return { posts, deps };
}

function resourceAttributes(payload: any) {
  return (payload?.resourceSpans?.[0]?.resource?.attributes ?? []).concat(
    payload?.resourceMetrics?.[0]?.resource?.attributes ?? [],
  );
}

describe("US-007 AC1: buildTracesPayload resource attributes include nax.feature", () => {
  test("success: emits nax.feature resource attribute equal to the supplied feature", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildTracesPayload({
      serviceName: "nax",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startUnixNano: "1000",
      endUnixNano: "2000",
      feature: "my-feature",
      project: "proj-1",
      gitBranch: "main",
      gitSha: "abc123",
      runId: "r1",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      totalCost: 0.42,
      events: [],
    } as any);
    const attrs = payload.resourceSpans[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.feature", value: { stringValue: "my-feature" } });
  });

  test("success: also includes nax.run_id and nax.project on the same resource block", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildTracesPayload({
      serviceName: "nax",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startUnixNano: "1000",
      endUnixNano: "2000",
      feature: "f",
      project: "proj-1",
      runId: "r1",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      totalCost: 0,
      events: [],
    } as any);
    const attrs = payload.resourceSpans[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.run_id", value: { stringValue: "r1" } });
    expect(attrs).toContainEqual({ key: "nax.project", value: { stringValue: "proj-1" } });
  });

  test("boundary: omits nax.git.branch when gitBranch is not provided", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildTracesPayload({
      serviceName: "nax",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startUnixNano: "1000",
      endUnixNano: "2000",
      feature: "f",
      project: "proj-1",
      runId: "r1",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      totalCost: 0,
      events: [],
    } as any);
    const attrs = payload.resourceSpans[0].resource.attributes;
    expect(attrs.some((a: any) => a.key === "nax.git.branch")).toBe(false);
    expect(attrs.some((a: any) => a.key === "nax.git.sha")).toBe(false);
  });
});

describe("US-007 AC2: buildMetricsPayload (otlp.ts) resource attributes include nax.feature", () => {
  test("success: emits nax.feature resource attribute equal to the supplied feature", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      feature: "my-feature",
      project: "proj-1",
      timeUnixNano: "2000",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      totalCost: 0.42,
      totalDurationMs: 1234,
    } as any);
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.feature", value: { stringValue: "my-feature" } });
  });

  test("success: also includes nax.run_id and nax.project", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildMetricsPayload({
      serviceName: "nax",
      runId: "r42",
      feature: "f",
      project: "proj-2",
      timeUnixNano: "1000",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      totalCost: 0,
      totalDurationMs: 0,
    } as any);
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.run_id", value: { stringValue: "r42" } });
    expect(attrs).toContainEqual({ key: "nax.project", value: { stringValue: "proj-2" } });
  });

  test("boundary: emits git attributes when gitBranch and gitSha are provided", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      feature: "f",
      project: "proj-1",
      gitBranch: "feat-x",
      gitSha: "deadbeef",
      timeUnixNano: "1000",
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      totalCost: 0,
      totalDurationMs: 0,
    } as any);
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.git.branch", value: { stringValue: "feat-x" } });
    expect(attrs).toContainEqual({ key: "nax.git.sha", value: { stringValue: "deadbeef" } });
  });
});

describe("US-007 AC3: buildHeartbeatMetricsPayload resource attributes include nax.run_id", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
  const payload: any = buildHeartbeatMetricsPayload({
    serviceName: "nax",
    timeUnixNano: "5000",
    snapshot: snapshot(),
  });

  test("success: emits a nax.run_id resource attribute equal to the snapshot's run id", () => {
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.run_id", value: { stringValue: "r1" } });
  });

  test("boundary: still includes the service.name attribute (no regression)", () => {
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "service.name", value: { stringValue: "nax" } });
  });
});

describe("US-007 AC4: buildHeartbeatMetricsPayload gauge points retain the bare feature attribute", () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
  const payload: any = buildHeartbeatMetricsPayload({
    serviceName: "nax",
    timeUnixNano: "5000",
    snapshot: snapshot(),
  });
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP metric entries
  const byName = (n: string) => metrics.find((m: any) => m.name === n);

  test("nax.run.active gauge data point carries the bare 'feature' attribute (no nax.feature)", () => {
    const attrs = byName("nax.run.active").gauge.dataPoints[0].attributes;
    expect(attrs).toContainEqual({ key: "feature", value: { stringValue: "feat-1" } });
    expect(attrs.some((a: any) => a.key === "nax.feature")).toBe(false);
  });

  test("nax.run.cost_usd gauge data point still carries the bare 'feature' attribute", () => {
    const attrs = byName("nax.run.cost_usd").gauge.dataPoints[0].attributes;
    expect(attrs).toContainEqual({ key: "feature", value: { stringValue: "feat-1" } });
  });

  test("nax.run.phase_elapsed_ms gauge data point still carries the bare 'feature' attribute", () => {
    const attrs = byName("nax.run.phase_elapsed_ms").gauge.dataPoints[0].attributes;
    expect(attrs).toContainEqual({ key: "feature", value: { stringValue: "feat-1" } });
  });
});

describe("US-007 AC5: span-tree payload builder resource attributes include nax.project", () => {
  test("success: buildMetricsPayload carries nax.project derived from the new shared input", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase({
      runId: "r1",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 100,
      costUsd: 0.01,
      tier: "balanced",
      testStrategy: "tdd-simple",
      sessionModel: "single-session",
    });
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
      feature: "feat-1",
      project: "proj-1",
    });
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.project", value: { stringValue: "proj-1" } });
  });

  test("success: also includes nax.feature and nax.run_id on the same resource block", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase({
      runId: "r1",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 100,
      costUsd: 0.01,
      tier: "balanced",
      testStrategy: "tdd-simple",
      sessionModel: "single-session",
    });
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
      feature: "feat-1",
      project: "proj-1",
    });
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.feature", value: { stringValue: "feat-1" } });
    expect(attrs).toContainEqual({ key: "nax.run_id", value: { stringValue: "r1" } });
  });

  test("success: span-tree resource block matches the shared buildResourceAttributes output", () => {
    const agg = createPhaseMetricsAggregator();
    agg.recordPhase({
      runId: "r1",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 100,
      costUsd: 0.01,
      tier: "balanced",
      testStrategy: "tdd-simple",
      sessionModel: "single-session",
    });
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({
      serviceName: "my-service",
      runId: "r42",
      timeUnixNano: "1000",
      feature: "feat-x",
      project: "proj-x",
      gitBranch: "feat-branch",
      gitSha: "deadbeef",
    });
    const attrs = payload.resourceMetrics[0].resource.attributes;
    const expected = buildResourceAttributes({
      serviceName: "my-service",
      runId: "r42",
      feature: "feat-x",
      project: "proj-x",
      git: { branch: "feat-branch", sha: "deadbeef" },
    });
    for (const e of expected) {
      expect(attrs).toContainEqual(e);
    }
  });

  test("boundary: empty aggregator still emits nax.project on its resource block", () => {
    const agg = createPhaseMetricsAggregator();
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = agg.buildMetricsPayload({
      serviceName: "nax",
      runId: "r1",
      timeUnixNano: "1000",
      feature: "feat-empty",
      project: "proj-empty",
    });
    const attrs = payload.resourceMetrics[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.project", value: { stringValue: "proj-empty" } });
    expect(attrs).toContainEqual({ key: "nax.feature", value: { stringValue: "feat-empty" } });
  });

  test("sanity: createSpanTree still exports a usable spanTree", () => {
    const tree = createSpanTree("trace1", "run-span");
    const span = tree.buildStorySpan("s1", "0", "1000");
    expect(span.parentSpanId).toBe("run-span");
  });
});

describe("US-007 AC6: incremental span flush request carries nax.run_id resource attribute", () => {
  const baseCfg: OtelReporterConfig = {
    enabled: true,
    endpoint: "https://otlp.example.com/",
    headers: {},
    serviceName: "nax",
    timeoutMs: 1000,
    detail: "counts",
    heartbeatIntervalMs: 0,
    maxBatchSize: 64,
    flushIntervalMs: 50,
    maxQueueSize: 2_048,
  };

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  test("success: an incremental flush before run end emits nax.run_id on its resource block", async () => {
    const { posts, deps } = capturingPosts();
    const plugin = createOtelReporterPlugin(baseCfg, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({
      runId: "inc-run-1",
      feature: "feat-1",
      project: "proj-1",
      totalStories: 1,
      startTime: new Date().toISOString(),
    });
    await r.onPhaseComplete?.({
      runId: "inc-run-1",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 10,
      costUsd: 0.01,
      tier: "balanced",
      testStrategy: "tdd-simple",
    });

    // Allow the flushIntervalMs timer to fire before run end.
    await sleep(120);

    const traces = posts.filter((p) => p.url.endsWith("/v1/traces"));
    expect(traces.length).toBeGreaterThan(0);

    // At least one incremental traces request must carry nax.run_id.
    const withRunId = traces.some((p) =>
      (p.body?.resourceSpans?.[0]?.resource?.attributes ?? []).some(
        (a: any) => a.key === "nax.run_id" && a.value.stringValue === "inc-run-1",
      ),
    );
    expect(withRunId).toBe(true);

    await plugin.teardown?.();
  });

  test("success: the incremental resource block also carries nax.feature and nax.project", async () => {
    const { posts, deps } = capturingPosts();
    const plugin = createOtelReporterPlugin(baseCfg, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({
      runId: "inc-run-2",
      feature: "feat-2",
      project: "proj-2",
      totalStories: 1,
      startTime: new Date().toISOString(),
    });
    await r.onPhaseComplete?.({
      runId: "inc-run-2",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 10,
      costUsd: 0.01,
      tier: "balanced",
      testStrategy: "tdd-simple",
    });
    await sleep(120);

    const traces = posts.filter((p) => p.url.endsWith("/v1/traces"));
    expect(traces.length).toBeGreaterThan(0);

    const attrList = traces[0].body?.resourceSpans?.[0]?.resource?.attributes ?? [];
    expect(attrList).toContainEqual({ key: "nax.feature", value: { stringValue: "feat-2" } });
    expect(attrList).toContainEqual({ key: "nax.project", value: { stringValue: "proj-2" } });

    await plugin.teardown?.();
  });

  test("boundary: no incremental flush when no spans have been enqueued", async () => {
    const { posts, deps } = capturingPosts();
    const plugin = createOtelReporterPlugin(baseCfg, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({
      runId: "inc-run-empty",
      feature: "feat-empty",
      project: "proj-empty",
      totalStories: 1,
      startTime: new Date().toISOString(),
    });
    await sleep(120);

    const traces = posts.filter((p) => p.url.endsWith("/v1/traces"));
    expect(traces).toHaveLength(0);

    await plugin.teardown?.();
  });
});
