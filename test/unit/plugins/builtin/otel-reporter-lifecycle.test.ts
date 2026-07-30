import { describe, expect, spyOn, test } from "bun:test";
import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { type PostJsonDeps, createOtelReporterPlugin } from "@/plugins";
import { attr } from "../../../../src/plugins/builtin/otel-reporter/otlp";

/**
 * Heartbeat cadence/content, detail-level redaction (counts vs verbose), and
 * the flush/teardown lifecycle for the otel-reporter (US-008). Split out of
 * otel-reporter.test.ts because this story's behavior is a distinct concern
 * (span/gauge emission driven by onPhaseComplete + heartbeat + teardown)
 * layered on top of the run-start/story-complete/run-end coverage already
 * pinned there.
 */

const baseCfg: OtelReporterConfig = {
  enabled: true,
  endpoint: "https://otlp.example.com/",
  headers: {},
  serviceName: "nax",
  timeoutMs: 1000,
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

function metricsPosts(posts: Array<{ url: string; body: any }>) {
  return posts.filter((p) => p.url.endsWith("/v1/metrics"));
}

function tracesPosts(posts: Array<{ url: string; body: any }>) {
  return posts.filter((p) => p.url.endsWith("/v1/traces"));
}

function allTraceSpans(posts: Array<{ url: string; body: any }>) {
  return tracesPosts(posts).flatMap((p) => p.body.resourceSpans[0].scopeSpans[0].spans);
}

function findMetric(metrics: any[], name: string) {
  return metrics.find((m: any) => m.name === name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("otel-reporter heartbeat", () => {
  test("AC1-AC5: heartbeat gauges are exported once the interval elapses, carrying phase_elapsed_ms, cost_usd, and the full attribute set from the most recently completed phase", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin({ ...baseCfg, heartbeatIntervalMs: 40 }, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({
      runId: "hb1",
      feature: "f",
      totalStories: 2,
      startTime: new Date().toISOString(),
      project: "nax-proj",
    });
    await r.onPhaseComplete?.({
      runId: "hb1",
      scope: "story",
      storyId: "s1",
      phase: "test-writer",
      outcome: "passed",
      durationMs: 10,
      costUsd: 0.05,
      tier: "fast",
      testStrategy: "tdd-simple",
    });
    await r.onPhaseComplete?.({
      runId: "hb1",
      scope: "story",
      storyId: "s2",
      phase: "implementer",
      outcome: "passed",
      durationMs: 10,
      costUsd: 0.07,
      tier: "balanced",
      testStrategy: "tdd-simple",
    });

    await sleep(200); // > heartbeatIntervalMs (40ms)

    const hbPosts = metricsPosts(posts);
    expect(hbPosts.length).toBeGreaterThan(0); // AC1

    const metrics = hbPosts[0].body.resourceMetrics[0].scopeMetrics[0].metrics;
    const active = findMetric(metrics, "nax.run.active");
    const elapsed = findMetric(metrics, "nax.run.phase_elapsed_ms");
    const cost = findMetric(metrics, "nax.run.cost_usd");

    expect(active?.gauge?.dataPoints?.[0]?.asDouble).toBe(1); // AC1
    expect(elapsed?.gauge?.dataPoints?.[0]?.asDouble).toBeGreaterThanOrEqual(0); // AC2
    expect(cost?.gauge?.dataPoints?.[0]?.asDouble).toBeCloseTo(0.12, 5); // AC3

    const attrs = active?.gauge?.dataPoints?.[0]?.attributes ?? [];
    expect(attrs).toContainEqual(attr("phase", "implementer")); // AC4 — most recently completed phase
    expect(attrs).toContainEqual(attr("run_id", "hb1")); // AC5
    expect(attrs).toContainEqual(attr("feature", "f"));
    expect(attrs).toContainEqual(attr("project", "nax-proj"));
    expect(attrs).toContainEqual(attr("story_id", "s2"));
    expect(attrs).toContainEqual(attr("tier", "balanced"));
    expect(attrs).toContainEqual(attr("test_strategy", "tdd-simple"));
  });

  test("AC6: heartbeatIntervalMs=0 issues no heartbeat export regardless of elapsed time", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin({ ...baseCfg, heartbeatIntervalMs: 0 }, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({ runId: "hb0", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
    await sleep(150);

    expect(metricsPosts(posts)).toHaveLength(0);
  });

  test("AC7/AC14: after onRunEnd (with no preceding run:completed bus event), no further heartbeat export is issued", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin({ ...baseCfg, heartbeatIntervalMs: 40 }, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({ runId: "hb7", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
    await sleep(150); // allow at least one heartbeat tick to have a chance to fire

    await r.onRunEnd?.({
      runId: "hb7",
      totalDurationMs: 150,
      totalCost: 0,
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    });
    const countAtEnd = metricsPosts(posts).length;

    await sleep(150); // several more heartbeat intervals worth of time
    expect(metricsPosts(posts).length).toBe(countAtEnd);
  });
});

describe("otel-reporter detail-gated review payloads", () => {
  test("AC8+AC9: detail='counts' — the review phase span carries no items array and no finding message text anywhere in the exported payload", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin({ ...baseCfg, detail: "counts" }, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({ runId: "r89", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
    await r.onPhaseComplete?.({
      runId: "r89",
      scope: "story",
      storyId: "s1",
      phase: "adversarial-review",
      outcome: "passed",
      durationMs: 20,
      costUsd: 0.02,
      details: {
        kind: "review",
        reviewer: "adversarial",
        bySeverity: { critical: 0, error: 1, warning: 0, info: 0, low: 0, unverifiable: 0 },
        blockingCount: 1,
        advisoryCount: 0,
      },
    });
    await r.onRunEnd?.({
      runId: "r89",
      totalDurationMs: 100,
      totalCost: 0.02,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });

    const reviewSpan = allTraceSpans(posts).find((s: any) =>
      (s.attributes ?? []).some((a: any) => a.key === "phase" && a.value.stringValue === "adversarial-review"),
    );
    expect(reviewSpan).toBeDefined(); // exported at all

    const serialized = JSON.stringify(posts.map((p) => p.body));
    expect(serialized).not.toContain('"items"');
  });

  test("AC10: detail='verbose' — the exported payload contains a span event carrying a review finding's message", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin({ ...baseCfg, detail: "verbose" }, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({ runId: "r10", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
    await r.onPhaseComplete?.({
      runId: "r10",
      scope: "story",
      storyId: "s1",
      phase: "adversarial-review",
      outcome: "passed",
      durationMs: 20,
      costUsd: 0.02,
      details: { kind: "review", reviewer: "adversarial", items: [{ message: "missing-null-check" }] },
    });
    await r.onRunEnd?.({
      runId: "r10",
      totalDurationMs: 100,
      totalCost: 0.02,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });

    const serialized = JSON.stringify(posts.map((p) => p.body));
    expect(serialized).toContain("missing-null-check");
  });

  // Assumption: `Finding.file` is documented as always workdir-relative at the
  // source (src/findings/types.ts), so this AC is interpreted as a pass-through
  // guarantee — the reporter must forward an already-relative path unchanged
  // and must never emit an absolute one, not re-derive relativity itself.
  test("AC11: detail='verbose' — every exported file path is relative to the repository root", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin({ ...baseCfg, detail: "verbose" }, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({ runId: "r11", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
    await r.onPhaseComplete?.({
      runId: "r11",
      scope: "story",
      storyId: "s1",
      phase: "adversarial-review",
      outcome: "passed",
      durationMs: 20,
      costUsd: 0.02,
      details: { kind: "review", reviewer: "adversarial", items: [{ message: "leaked var", file: "src/foo.ts" }] },
    });
    await r.onRunEnd?.({
      runId: "r11",
      totalDurationMs: 100,
      totalCost: 0.02,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });

    const serialized = JSON.stringify(posts.map((p) => p.body));
    expect(serialized).toContain("src/foo.ts");
    expect(serialized).not.toMatch(/"file"\s*:\s*"\//);
  });
});

describe("otel-reporter log redaction", () => {
  test("AC12: no log record produced during export contains a resolved header value", async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    const logger = initLogger({ level: "silent" });
    const spies = {
      error: spyOn(logger, "error"),
      warn: spyOn(logger, "warn"),
      info: spyOn(logger, "info"),
      debug: spyOn(logger, "debug"),
    };

    try {
      process.env.OTLP_TOKEN = "super-secret-token-value";
      const { posts, deps } = capturing();
      const plugin = createOtelReporterPlugin(
        { ...baseCfg, headers: { Authorization: "Bearer ${OTLP_TOKEN}" } },
        deps,
      );
      const r = plugin.extensions.reporter!;

      await r.onRunStart?.({ runId: "r12", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
      await r.onPhaseComplete?.({
        runId: "r12",
        scope: "story",
        storyId: "s1",
        phase: "implementer",
        outcome: "passed",
        durationMs: 10,
        costUsd: 0.01,
      });
      await r.onRunEnd?.({
        runId: "r12",
        totalDurationMs: 100,
        totalCost: 0.01,
        storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      });
      await plugin.teardown?.();
      void posts;

      const allCalls = [
        ...spies.error.mock.calls,
        ...spies.warn.mock.calls,
        ...spies.info.mock.calls,
        ...spies.debug.mock.calls,
      ];
      expect(JSON.stringify(allCalls)).not.toContain("super-secret-token-value");
    } finally {
      spies.error.mockRestore();
      spies.warn.mockRestore();
      spies.info.mockRestore();
      spies.debug.mockRestore();
      delete process.env.OTLP_TOKEN;
      resetLogger();
    }
  });
});

describe("otel-reporter flush and teardown lifecycle", () => {
  test("AC13: onRunEnd (with no preceding run:completed bus event) exports every queued phase span", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(baseCfg, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({ runId: "r13", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
    const phases = ["test-writer", "implementer", "verifier"];
    for (const phase of phases) {
      await r.onPhaseComplete?.({
        runId: "r13",
        scope: "story",
        storyId: "s1",
        phase,
        outcome: "passed",
        durationMs: 10,
        costUsd: 0.01,
      });
    }
    await r.onRunEnd?.({
      runId: "r13",
      totalDurationMs: 100,
      totalCost: 0.03,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });

    const spans = allTraceSpans(posts);
    for (const phase of phases) {
      const found = spans.some((s: any) => (s.attributes ?? []).some((a: any) => a.key === "phase" && a.value.stringValue === phase));
      expect(found).toBe(true);
    }
  });

  test("AC15: teardown invoked without a prior onRunEnd flushes as a backstop, and a second teardown call issues no additional export", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(baseCfg, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({ runId: "r15", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
    await r.onPhaseComplete?.({
      runId: "r15",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 10,
      costUsd: 0.01,
    });

    expect(posts).toHaveLength(0); // nothing exported yet — flush is deferred to onRunEnd/teardown

    await plugin.teardown?.();
    expect(posts.length).toBeGreaterThan(0); // backstop flush

    const afterFirstTeardown = posts.length;
    await plugin.teardown?.(); // idempotent — AC15
    expect(posts.length).toBe(afterFirstTeardown);
  });

  test("AC15 boundary: teardown invoked after onRunEnd has already completed issues no additional export request", async () => {
    const { posts, deps } = capturing();
    const plugin = createOtelReporterPlugin(baseCfg, deps);
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({ runId: "r15b", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "nax" });
    await r.onRunEnd?.({
      runId: "r15b",
      totalDurationMs: 10,
      totalCost: 0,
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    });
    const afterRunEnd = posts.length;

    await plugin.teardown?.();
    expect(posts.length).toBe(afterRunEnd);
  });

  test("AC16: onRunEnd with no preceding onRunStart exports a run span whose start is back-computed from the reported duration", async () => {
    const { posts, deps } = capturing();
    const r = createOtelReporterPlugin(baseCfg, deps).extensions.reporter!;

    const before = Date.now();
    await r.onRunEnd?.({
      runId: "r16",
      totalDurationMs: 5_000,
      totalCost: 0,
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    });
    const after = Date.now();

    const span = tracesPosts(posts)[0]?.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span).toBeDefined();
    const startMs = Number(BigInt(span.startTimeUnixNano) / 1_000_000n);
    expect(startMs).toBeGreaterThanOrEqual(before - 5_000 - 50);
    expect(startMs).toBeLessThanOrEqual(after - 5_000 + 50);
  });
});
