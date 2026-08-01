/**
 * Git-resolution tests at onRunStart (US-007 AC7 / AC8).
 *
 * When `gitWithTimeout(...)` fails to resolve branch or sha during
 * `onRunStart`, the hook must complete without throwing, and no subsequently
 * exported payload may carry `nax.git.branch` (or `nax.git.sha`). Both are
 * best-effort and must not stall or break the run lifecycle.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { createOtelReporterPlugin } from "@/plugins";
import type { PostJsonDeps } from "@/plugins/builtin/reporter-shared";
import { _gitDeps } from "@/utils/git";

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

let origSpawn: typeof _gitDeps.spawn;
beforeEach(() => {
  origSpawn = _gitDeps.spawn;
});
afterEach(() => {
  _gitDeps.spawn = origSpawn;
  mock.restore();
});

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

/** Mock spawn that produces a stderr-throwing proc to simulate any git failure. */
function spawnAlwaysFails(): typeof _gitDeps.spawn {
  return mock((_args: string[], _opts: unknown) => {
    const bytes = new TextEncoder().encode("fatal: not a git repository\n");
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      exited: Promise.resolve(128),
      kill: mock(() => {}),
    } as any;
  }) as typeof _gitDeps.spawn;
}

/** Mock spawn whose `exited` resolves synchronously then rejects from stdout text(). */
function spawnThrowsOnRead(): typeof _gitDeps.spawn {
  return mock((_args: string[], _opts: unknown) => {
    return {
      stdout: new ReadableStream({
        start(c) {
          c.error(new Error("spawn EACCES"));
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(1),
      kill: mock(() => {}),
    } as any;
  }) as typeof _gitDeps.spawn;
}

describe("US-007 AC7: git branch and sha resolution failure does not throw onRunStart", () => {
  test("success: onRunStart attempts git resolution via _gitDeps.spawn and does not throw on failure", async () => {
    const spawnCalls: string[][] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      spawnCalls.push(args as string[]);
      const bytes = new TextEncoder().encode("fatal: not a git repository\n");
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        exited: Promise.resolve(128),
        kill: mock(() => {}),
      } as any;
    }) as typeof _gitDeps.spawn;

    const plugin = createOtelReporterPlugin(baseCfg, undefined, "/tmp/nax-test-repo");
    const r = plugin.extensions.reporter!;
    await expect(
      r.onRunStart?.({
        runId: "gitfail-1",
        feature: "f",
        project: "p",
        totalStories: 1,
        startTime: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();

    // The reporter must actually attempt git resolution — not silently skip it.
    expect(spawnCalls.length).toBeGreaterThan(0);
    expect(spawnCalls.some((args) => args[0] === "git" && args.includes("rev-parse"))).toBe(true);

    await plugin.teardown?.();
  });

  test("success: spawn throwing during git reads does not reject the onRunStart hook", async () => {
    _gitDeps.spawn = spawnThrowsOnRead();
    const plugin = createOtelReporterPlugin(baseCfg, undefined, "/tmp/nax-test-repo");
    const r = plugin.extensions.reporter!;
    await expect(
      r.onRunStart?.({
        runId: "gitfail-2",
        feature: "f",
        project: "p",
        totalStories: 1,
        startTime: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
    await plugin.teardown?.();
  });

  test("success: subsequent onStoryComplete and onRunEnd keep working after a git failure", async () => {
    _gitDeps.spawn = spawnAlwaysFails();
    const plugin = createOtelReporterPlugin(baseCfg, undefined, "/tmp/nax-test-repo");
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({
      runId: "gitfail-3",
      feature: "f",
      project: "p",
      totalStories: 1,
      startTime: new Date().toISOString(),
    });
    await expect(
      r.onStoryComplete?.({
        runId: "gitfail-3",
        storyId: "s1",
        status: "completed",
        runElapsedMs: 50,
        cost: 0.1,
        tier: "fast",
        testStrategy: "tdd-simple",
      }),
    ).resolves.toBeUndefined();
    await expect(
      r.onRunEnd?.({
        runId: "gitfail-3",
        totalDurationMs: 100,
        totalCost: 0.1,
        storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
      }),
    ).resolves.toBeUndefined();
    await plugin.teardown?.();
  });
});

describe("US-007 AC8: when git branch resolution fails, exported payloads omit nax.git.branch", () => {
  test("success: resource block on the run-end traces payload omits nax.git.branch after a git failure, but keeps identity attrs that did resolve", async () => {
    const spawnCalls: string[][] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      spawnCalls.push(args as string[]);
      const bytes = new TextEncoder().encode("fatal: not a git repository\n");
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        exited: Promise.resolve(128),
        kill: mock(() => {}),
      } as any;
    }) as typeof _gitDeps.spawn;
    const { posts, deps } = capturingPosts();
    const plugin = createOtelReporterPlugin(baseCfg, deps, "/tmp/nax-test-repo");
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({
      runId: "nogitbranch-1",
      feature: "f",
      project: "p",
      totalStories: 1,
      startTime: new Date().toISOString(),
    });

    // The reporter must have attempted git resolution; otherwise this AC
    // would pass trivially without doing the work.
    expect(spawnCalls.some((args) => args[0] === "git" && args.includes("rev-parse"))).toBe(true);

    await r.onRunEnd?.({
      runId: "nogitbranch-1",
      totalDurationMs: 10,
      totalCost: 0,
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    });

    // Inspect every captured resource block — terminal traces + terminal metrics.
    const allAttrs: any[] = [];
    for (const p of posts) {
      const body = p.body ?? {};
      allAttrs.push(...(body?.resourceSpans?.[0]?.resource?.attributes ?? []));
      allAttrs.push(...(body?.resourceMetrics?.[0]?.resource?.attributes ?? []));
    }
    expect(allAttrs.some((a) => a.key === "nax.git.branch")).toBe(false);
    expect(allAttrs.some((a) => a.key === "nax.git.sha")).toBe(false);

    await plugin.teardown?.();
  });

  test("success: a metrics payload exported after a git failure also carries no nax.git.branch", async () => {
    const spawnCalls: string[][] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      spawnCalls.push(args as string[]);
      return {
        stdout: new ReadableStream({
          start(c) {
            c.error(new Error("spawn EACCES"));
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        exited: Promise.resolve(1),
        kill: mock(() => {}),
      } as any;
    }) as typeof _gitDeps.spawn;
    const { posts, deps } = capturingPosts();
    const plugin = createOtelReporterPlugin(baseCfg, deps, "/tmp/nax-test-repo");
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({
      runId: "nogitbranch-2",
      feature: "f",
      project: "p",
      totalStories: 1,
      startTime: new Date().toISOString(),
    });
    await r.onStoryComplete?.({
      runId: "nogitbranch-2",
      storyId: "s1",
      status: "completed",
      runElapsedMs: 50,
      cost: 0.1,
      tier: "fast",
      testStrategy: "tdd-simple",
    });
    await r.onRunEnd?.({
      runId: "nogitbranch-2",
      totalDurationMs: 100,
      totalCost: 0.1,
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    });

    // Reporter must have attempted git resolution.
    expect(spawnCalls.some((args) => args[0] === "git" && args.includes("rev-parse"))).toBe(true);

    const metricsPosts = posts.filter((p) => p.url.endsWith("/v1/metrics"));
    expect(metricsPosts.length).toBeGreaterThan(0);
    const metricsAttrs = metricsPosts.flatMap((p) => p.body?.resourceMetrics?.[0]?.resource?.attributes ?? []);
    expect(metricsAttrs.some((a: any) => a.key === "nax.git.branch")).toBe(false);
    expect(metricsAttrs.some((a: any) => a.key === "nax.git.sha")).toBe(false);

    await plugin.teardown?.();
  });
});
