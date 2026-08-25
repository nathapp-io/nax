/**
 * Exporter wiring and lifecycle (US-005).
 *
 * Wires opt-in OTLP log export from the redacted logger sink through a
 * dedicated queue. The logs queue is a separate `createBatchQueue` instance
 * so a log burst cannot evict queued spans; the exporter's own log entries
 * are dropped by stage before enqueue so a failed export cannot recurse.
 *
 * Each AC has at least one success-path test and a boundary/failure-path
 * test. Tests run against the existing `createOtelReporterPlugin` factory;
 * the otel-reporter's failing-test surface lives in the same shape as the
 * existing reports in `otel-reporter-lifecycle.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mockFetch, withWarnSpy } from "@test/helpers";
import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { initLogger, resetLogger } from "@/logger";
import { buildLogsPayload, createOtelReporterPlugin, type PostJsonDeps } from "@/plugins";

interface CapturedPost {
  url: string;
  body: any;
}

function capturingDeps() {
  const posts: CapturedPost[] = [];
  const deps: PostJsonDeps = {
    fetch: mockFetch(async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    }),
  };
  return { posts, deps };
}

const logsPosts = (posts: CapturedPost[]) => posts.filter((p) => p.url.endsWith("/v1/logs"));
const tracesPosts = (posts: CapturedPost[]) => posts.filter((p) => p.url.endsWith("/v1/traces"));
const allLogRecords = (posts: CapturedPost[]): any[] =>
  logsPosts(posts).flatMap((p) => p.body?.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords ?? []);
const findLogRecord = (posts: CapturedPost[], predicate: (rec: any) => boolean): any | undefined =>
  allLogRecords(posts).find(predicate);

const baseCfg: OtelReporterConfig = {
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

const originalOtlpToken = process.env.OTLP_TOKEN;

beforeEach(() => {
  resetLogger();
  initLogger({ level: "debug" });
});

afterEach(() => {
  resetLogger();
  if (originalOtlpToken === undefined) delete process.env.OTLP_TOKEN;
  else process.env.OTLP_TOKEN = originalOtlpToken;
});

interface RunFixture {
  runId: string;
  feat?: string;
  startTime?: string;
}

async function startRun(plugin: ReturnType<typeof createOtelReporterPlugin>, fixture: RunFixture) {
  const r = plugin.extensions.reporter!;
  await r.onRunStart?.({
    runId: fixture.runId,
    feature: fixture.feat ?? "f",
    totalStories: 1,
    startTime: fixture.startTime ?? new Date().toISOString(),
    project: "nax",
  });
  return r;
}

async function endRun(r: ReturnType<typeof createOtelReporterPlugin>["extensions"]["reporter"], runId: string) {
  await r?.onRunEnd?.({
    runId,
    totalDurationMs: 10,
    totalCost: 0,
    storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
  });
}

function makeLogsOn(logs: any) {
  return { ...baseCfg, logs } as any;
}

function makeHeadersLogsOn(headers: Record<string, string>, logs: any) {
  return { ...baseCfg, headers, logs } as any;
}

// ─── AC1: buildLogsPayload resource attributes include nax.feature ───────────
// logs.ts already exists from US-004; this is the missing coverage gap.
describe("AC1: buildLogsPayload resource attributes include nax.feature", () => {
  test("success: emits a nax.feature resource attribute equal to the supplied feature", () => {
    const payload: any = buildLogsPayload(
      [{ timestamp: "2025-01-01T00:00:00.000Z", level: "info", stage: "verify", message: "test" }],
      { serviceName: "nax", runId: "r1", feature: "my-feature" },
    );
    const attrs = payload.resourceLogs[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.feature", value: { stringValue: "my-feature" } });
  });

  test("boundary: emits a nax.run_id resource attribute alongside nax.feature", () => {
    const payload: any = buildLogsPayload(
      [{ timestamp: "2025-01-01T00:00:00.000Z", level: "info", stage: "verify", message: "test" }],
      { serviceName: "nax", runId: "run-abc", feature: "feat-x" },
    );
    const attrs = payload.resourceLogs[0].resource.attributes;
    expect(attrs).toContainEqual({ key: "nax.feature", value: { stringValue: "feat-x" } });
    expect(attrs).toContainEqual({ key: "nax.run_id", value: { stringValue: "run-abc" } });
  });
});

// ─── AC2 / AC3: schema defaults for logs.enabled / logs.level ─────────────────
// Moved to test/unit/config/reporters-schema.test.ts to keep the file below the
// 800-line size limit and to colocate schema tests with the existing schema suite.

describe("AC4: onRunStart does not call addSink when logs.enabled is false", () => {
  test("success: a reporter with logs.enabled=false completes onRunStart without registering a sink", async () => {
    const addSinkSpy = spyOn(await import("@/logger"), "addSink");
    addSinkSpy.mockClear();
    try {
      const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: false, level: "info" }));
      await startRun(plugin, { runId: "ac4" });
      expect(addSinkSpy.mock.calls.length).toBe(0);
    } finally {
      addSinkSpy.mockRestore();
    }
  });

  test("boundary: logging immediately after onRunStart with logs.enabled=false does not POST to /v1/logs", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: false, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac4b" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "should not be exported");
    await endRun(r, "ac4b");
    expect(logsPosts(posts)).toHaveLength(0);
  });
});

describe("AC5: onRunStart calls addSink exactly once when logs.enabled is true", () => {
  test("success: addSink is invoked exactly once on onRunStart when logs.enabled is true", async () => {
    const addSinkSpy = spyOn(await import("@/logger"), "addSink");
    addSinkSpy.mockClear();
    try {
      const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }));
      await startRun(plugin, { runId: "ac5" });
      expect(addSinkSpy.mock.calls.length).toBe(1);
    } finally {
      addSinkSpy.mockRestore();
    }
  });

  test("boundary: a second onRunStart for a different runId registers a second sink", async () => {
    const addSinkSpy = spyOn(await import("@/logger"), "addSink");
    addSinkSpy.mockClear();
    try {
      const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }));
      const r = await startRun(plugin, { runId: "ac5a" });
      await startRun(plugin, { runId: "ac5b" });
      expect(addSinkSpy.mock.calls.length).toBe(2);
      void r;
    } finally {
      addSinkSpy.mockRestore();
    }
  });
});

describe('AC6: severity floor drops an info entry when logs.level is "warn"', () => {
  test('success: an info entry is not enqueued when logs.level is "warn"', async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "warn" }), deps);
    const r = await startRun(plugin, { runId: "ac6" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "this should be dropped");
    await endRun(r, "ac6");
    expect(allLogRecords(posts)).toHaveLength(0);
  });

  test('boundary: a debug entry is also dropped under logs.level="warn"', async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "warn" }), deps);
    const r = await startRun(plugin, { runId: "ac6b" });
    const { getLogger } = await import("@/logger");
    getLogger().debug("verify", "noise");
    await endRun(r, "ac6b");
    expect(allLogRecords(posts)).toHaveLength(0);
  });
});

describe('AC7: severity floor passes a warn entry when logs.level is "warn"', () => {
  test('success: a warn entry is enqueued and posted when logs.level is "warn"', async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "warn" }), deps);
    const r = await startRun(plugin, { runId: "ac7" });
    const { getLogger } = await import("@/logger");
    getLogger().warn("verify", "real warning");
    await endRun(r, "ac7");
    const records = allLogRecords(posts);
    expect(records.length).toBeGreaterThan(0);
    const found = findLogRecord(posts, (rec) => rec.body?.stringValue === "real warning");
    expect(found).toBeDefined();
    expect(found?.severityNumber).toBe(13);
  });

  test('boundary: an error entry is also passed under logs.level="warn"', async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "warn" }), deps);
    const r = await startRun(plugin, { runId: "ac7b" });
    const { getLogger } = await import("@/logger");
    getLogger().error("verify", "real error");
    await endRun(r, "ac7b");
    expect(findLogRecord(posts, (rec) => rec.body?.stringValue === "real error")).toBeDefined();
  });
});

describe('AC8: log entry stage "otel-batch-queue" is dropped before enqueue', () => {
  test('success: a log entry whose stage equals "otel-batch-queue" is not enqueued', async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac8" });
    const { getLogger } = await import("@/logger");
    getLogger().warn("otel-batch-queue", "should not be enqueued");
    getLogger().info("verify", "should be enqueued");
    await endRun(r, "ac8");
    const records = allLogRecords(posts);
    expect(records.some((rec) => rec.body?.stringValue === "should not be enqueued")).toBe(false);
    expect(records.some((rec) => rec.body?.stringValue === "should be enqueued")).toBe(true);
  });

  test("boundary: a similar-but-different stage name is still enqueued", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac8b" });
    const { getLogger } = await import("@/logger");
    getLogger().info("otel-batch-queue-watcher", "should pass through");
    await endRun(r, "ac8b");
    expect(findLogRecord(posts, (rec) => rec.body?.stringValue === "should pass through")).toBeDefined();
  });
});

describe("AC9: a logged message is exported to /v1/logs when the queue flushes", () => {
  test('success: the message "no test command" is exported as a log record body.stringValue', async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac9" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "no test command");
    await endRun(r, "ac9");
    expect(logsPosts(posts).length).toBeGreaterThan(0);
    expect(findLogRecord(posts, (rec) => rec.body?.stringValue === "no test command")).toBeDefined();
  });

  test("boundary: the posted log record carries the same stage that was logged", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac9b" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "no test command");
    await endRun(r, "ac9b");
    const found = findLogRecord(posts, (rec) => rec.body?.stringValue === "no test command");
    expect(found).toBeDefined();
    const stage = found?.attributes?.find((a: any) => a.key === "nax.stage");
    expect(stage?.value?.stringValue).toBe("verify");
  });
});

describe("AC10: logs export request URL ends in /v1/logs", () => {
  test("success: a successful log export POSTs to <endpoint>/v1/logs", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac10" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "ping");
    await endRun(r, "ac10");
    const logs = logsPosts(posts);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].url).toBe("https://otlp.example.com/v1/logs");
  });

  test("boundary: the trace and metrics endpoints are not affected by logs export", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac10b" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "x");
    await endRun(r, "ac10b");
    expect(tracesPosts(posts).length).toBeGreaterThan(0);
  });
});

describe("AC11: onRunEnd posts queued log records", () => {
  test("success: log records enqueued during a run are POSTed when onRunEnd runs", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac11" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "queued-before-flush");
    expect(logsPosts(posts)).toHaveLength(0);
    await endRun(r, "ac11");
    expect(logsPosts(posts).length).toBeGreaterThan(0);
    expect(findLogRecord(posts, (rec) => rec.body?.stringValue === "queued-before-flush")).toBeDefined();
  });

  test("boundary: an empty log queue still results in no /v1/logs POST when onRunEnd runs", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac11b" });
    await endRun(r, "ac11b");
    expect(logsPosts(posts)).toHaveLength(0);
  });
});

describe("AC12: teardown after onRunEnd posts no further logs request", () => {
  test("success: a second teardown (or teardown after onRunEnd) does not POST to /v1/logs", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    const r = await startRun(plugin, { runId: "ac12" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "msg");
    await endRun(r, "ac12");
    const afterRunEnd = logsPosts(posts).length;
    expect(afterRunEnd).toBeGreaterThan(0);
    await plugin.teardown?.();
    expect(logsPosts(posts).length).toBe(afterRunEnd);
    await plugin.teardown?.();
    expect(logsPosts(posts).length).toBe(afterRunEnd);
  });

  test("boundary: teardown invoked WITHOUT a prior onRunEnd does flush queued logs as a backstop", async () => {
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(makeLogsOn({ enabled: true, level: "info" }), deps);
    await startRun(plugin, { runId: "ac12b" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "backstop-msg");
    expect(logsPosts(posts)).toHaveLength(0);
    await plugin.teardown?.();
    expect(logsPosts(posts).length).toBeGreaterThan(0);
    expect(findLogRecord(posts, (rec) => rec.body?.stringValue === "backstop-msg")).toBeDefined();
  });
});

describe("AC13: a configured header referencing an unset env var skips the logs request", () => {
  test("success: when logs headers reference an unset env var, no POST is sent to /v1/logs", async () => {
    delete process.env.OTLP_TOKEN;
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(
      makeHeadersLogsOn({ Authorization: "Bearer ${OTLP_TOKEN}" }, { enabled: true, level: "info" }),
      deps,
    );
    const r = await startRun(plugin, { runId: "ac13" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "msg");
    await endRun(r, "ac13");
    expect(logsPosts(posts)).toHaveLength(0);
  });

  test("boundary: setting the env var causes the logs request to be sent", async () => {
    process.env.OTLP_TOKEN = "secret-token";
    const { posts, deps } = capturingDeps();
    const plugin = createOtelReporterPlugin(
      makeHeadersLogsOn({ Authorization: "Bearer ${OTLP_TOKEN}" }, { enabled: true, level: "info" }),
      deps,
    );
    const r = await startRun(plugin, { runId: "ac13b" });
    const { getLogger } = await import("@/logger");
    getLogger().info("verify", "msg");
    await endRun(r, "ac13b");
    expect(logsPosts(posts).length).toBeGreaterThan(0);
  });
});

describe("AC14: when logs headers reference unset env vars, the reporter warns (with the missing variable names) without consuming a logs-queue retry", () => {
  test("success: the reporter warns with the missing variable names and skips export", async () => {
    delete process.env.OTLP_TOKEN;
    delete process.env.OTLP_OTHER;
    await withWarnSpy(async (warnSpy) => {
      const { posts, deps } = capturingDeps();
      const plugin = createOtelReporterPlugin(
        makeHeadersLogsOn(
          { Authorization: "Bearer ${OTLP_TOKEN}", "X-Other": "${OTLP_OTHER}" },
          { enabled: true, level: "info" },
        ),
        deps,
      );
      const r = await startRun(plugin, { runId: "ac14" });
      const { getLogger } = await import("@/logger");
      getLogger().info("verify", "msg");
      await endRun(r, "ac14");
      const exportWarnings = warnSpy.mock.calls.filter((c) => c[0] === "otel-reporter");
      expect(exportWarnings.length).toBeGreaterThan(0);
      const flattened = JSON.stringify(exportWarnings);
      expect(flattened).toContain("OTLP_TOKEN");
      expect(flattened).toContain("OTLP_OTHER");
      expect(logsPosts(posts)).toHaveLength(0);
    });
  });

  test("boundary: a configuration with no unresolved headers does not emit the skip-with-warning", async () => {
    process.env.OTLP_TOKEN = "secret-token";
    await withWarnSpy(async (warnSpy) => {
      const { posts, deps } = capturingDeps();
      const plugin = createOtelReporterPlugin(
        makeHeadersLogsOn({ Authorization: "Bearer ${OTLP_TOKEN}" }, { enabled: true, level: "info" }),
        deps,
      );
      const r = await startRun(plugin, { runId: "ac14b" });
      const { getLogger } = await import("@/logger");
      getLogger().info("verify", "msg");
      await endRun(r, "ac14b");
      const exportWarnings = warnSpy.mock.calls.filter(
        (c) => c[0] === "otel-reporter" && typeof c[1] === "string" && c[1].includes("unresolved env vars"),
      );
      expect(exportWarnings).toHaveLength(0);
      expect(logsPosts(posts).length).toBeGreaterThan(0);
    });
  });
});
