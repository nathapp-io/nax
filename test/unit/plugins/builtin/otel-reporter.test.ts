import { describe, expect, test } from "bun:test";
import { createOtelReporterPlugin, type PostJsonDeps } from "@/plugins";
import type { OtelReporterConfig } from "@/config/schemas-reporters";

const cfg: OtelReporterConfig = {
  enabled: true,
  endpoint: "https://otlp.example.com/",
  headers: {},
  serviceName: "nax",
  timeoutMs: 1000,
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
  await r.onRunStart?.({ runId: "r1", feature: "f", totalStories: 2, startTime: "2026-07-18T00:00:00.000Z" });
  await r.onStoryComplete?.({ runId: "r1", storyId: "s1", status: "completed", runElapsedMs: 100, cost: 0.1, tier: "fast", testStrategy: "tdd-simple" });
  await r.onStoryComplete?.({ runId: "r1", storyId: "s2", status: "failed", runElapsedMs: 200, cost: 0.2, tier: "balanced", testStrategy: "tdd-simple" });
  await r.onRunEnd?.({ runId: "r1", totalDurationMs: 300, totalCost: 0.3, storySummary: { completed: 1, failed: 1, skipped: 0, paused: 0 } });
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
    // startMs(0) + runElapsedMs(100) -> 100ms -> 100_000_000 ns
    expect(span.events[0].timeUnixNano).toBe("100000000");
    expect(span.status.code).toBe(2); // one failed
  });

  test("emits no story events before onRunStart is dropped (no state)", async () => {
    const { posts, deps } = capturing();
    const r = createOtelReporterPlugin(cfg, deps).extensions.reporter!;
    // onStoryComplete with no prior onRunStart is a no-op, not a throw
    await r.onStoryComplete?.({ runId: "x", storyId: "s", status: "completed", runElapsedMs: 5, cost: 0, tier: "fast", testStrategy: "tdd-simple" });
    expect(posts).toHaveLength(0);
  });

  test("onRunEnd without a prior onRunStart still flushes a best-effort span", async () => {
    const { posts, deps } = capturing();
    const r = createOtelReporterPlugin(cfg, deps).extensions.reporter!;
    await r.onRunEnd?.({ runId: "orphan", totalDurationMs: 300, totalCost: 0.3, storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 } });
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
    await plugin.extensions.reporter?.onStoryComplete?.({ runId: "r1", storyId: "s3", status: "completed", runElapsedMs: 400, cost: 0, tier: "fast", testStrategy: "tdd-simple" });
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
});
