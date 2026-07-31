import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { OtelReporterConfigSchema } from "../../../src/config/schemas-reporters";
import type { OtelReporterConfig } from "../../../src/config/schemas-reporters";
import { addSink, getLogger, initLogger, resetLogger } from "../../../src/logger";
import type { LogEntry } from "../../../src/logger";
import { createOtelReporterPlugin } from "../../../src/plugins/builtin/otel-reporter";
import { buildHeartbeatMetricsPayload } from "../../../src/plugins/builtin/otel-reporter/heartbeat";
import type { HeartbeatMetricsInput } from "../../../src/plugins/builtin/otel-reporter/heartbeat";
import { buildLogsPayload, toLogRecord } from "../../../src/plugins/builtin/otel-reporter/logs";
import {
  type KeyValue,
  type MetricsInput,
  type TracesInput,
  buildMetricsPayload,
  buildResourceAttributes,
  buildTracesPayload,
} from "../../../src/plugins/builtin/otel-reporter/otlp";
import { createPhaseMetricsAggregator } from "../../../src/plugins/builtin/otel-reporter/span-tree";
import { NAX_VERSION } from "../../../src/version";
import { _gitDeps } from "../../../src/utils/git";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers/temp";
import { withWarnSpy } from "../../../test/helpers/warn-spy";

function findAttr(attrs: KeyValue[], key: string): KeyValue | undefined {
  return attrs.find((a) => a.key === key);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: "2024-01-15T10:30:00.000Z",
    level: "info",
    stage: "test-stage",
    message: "test message",
    ...overrides,
  };
}

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
};

function capturingFetch() {
  const posts: Array<{ url: string; body: any; raw: string }> = [];
  const fetch = async (url: unknown, init?: RequestInit) => {
    const raw = String(init?.body);
    posts.push({ url: String(url), body: JSON.parse(raw), raw });
    return new Response(null, { status: 200 });
  };
  return { posts, fetch };
}

// ---------------------------------------------------------------------------
// US-001 — Logger sink seam
// ---------------------------------------------------------------------------

describe("US-001: logger sink seam", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetLogger();
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    initLogger({ level: "debug" });
  });

  afterEach(() => {
    resetLogger();
    consoleSpy.mockRestore();
  });

  test("AC-1: addSink returns a function when called with a no-op sink", () => {
    const unsub = addSink(() => {});
    expect(typeof unsub).toBe("function");
  });

  test("AC-2: sink receives entry.message equal to the logged message", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("verify", "no test command");
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe("no test command");
  });

  test("AC-3: sink receives entry.stage equal to the stage passed to the log call", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("verify", "test");
    expect(calls[0].stage).toBe("verify");
  });

  test("AC-4: sink receives entry.level equal to the severity of the invoked method", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().warn("some-stage", "test");
    expect(calls[0].level).toBe("warn");
  });

  test("AC-5: sink receives a valid ISO-8601 timestamp", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("some-stage", "test");
    const iso = new Date(calls[0].timestamp).toISOString();
    expect(iso.startsWith(String(new Date().getFullYear()))).toBe(true);
  });

  test("AC-6: story-scoped log call delivers storyId to the sink", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().withStory("story-abc").info("some-stage", "test");
    expect(calls[0].storyId).toBe("story-abc");
  });

  test("AC-7: apiKey value is redacted before reaching the sink", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("some-stage", "test", { apiKey: "sk-live-abc123" });
    expect(calls[0].data?.apiKey).toBe("[REDACTED]");
  });

  test("AC-8: token-shaped substring in message is redacted before reaching the sink", () => {
    const calls: LogEntry[] = [];
    addSink((entry) => calls.push(entry));
    getLogger().info("some-stage", "token ghp_0123456789abcdefghij failed");
    expect(calls[0].message).toBe("token [REDACTED] failed");
  });

  test("AC-9: invoking the unsubscribe function stops further delivery", () => {
    const calls: LogEntry[] = [];
    const unsub = addSink((entry) => calls.push(entry));
    unsub();
    getLogger().info("some-stage", "test");
    expect(calls).toHaveLength(0);
  });

  test("AC-10: two registered sinks each receive the entry from one log call", () => {
    const calls1: LogEntry[] = [];
    const calls2: LogEntry[] = [];
    addSink((entry) => calls1.push(entry));
    addSink((entry) => calls2.push(entry));
    getLogger().info("some-stage", "test");
    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(1);
    expect(calls1[0]).toEqual(calls2[0]);
  });

  test("AC-11: a throwing sink does not prevent delivery to a subsequently registered sink", () => {
    const calls2: LogEntry[] = [];
    addSink(() => {
      throw new Error("sink error");
    });
    addSink((entry) => calls2.push(entry));
    getLogger().info("some-stage", "test");
    expect(calls2).toHaveLength(1);
    expect(calls2[0].message).toBe("test");
  });

  test("AC-12: the JSONL file still receives the entry when a registered sink throws", async () => {
    const tempDir = makeTempDir("nax-otlp-logs-");
    try {
      resetLogger();
      const logPath = join(tempDir, "run.jsonl");
      const fileLogger = initLogger({ level: "info", filePath: logPath });
      addSink(() => {
        throw new Error("sink error");
      });
      fileLogger.info("some-stage", "test");
      await fileLogger.flush();
      const content = readFileSync(logPath, "utf8");
      const entry = JSON.parse(content.trim());
      expect(entry.message).toBe("test");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test("AC-13: a log call does not throw when a registered sink throws", () => {
    addSink(() => {
      throw new Error("sink error");
    });
    expect(() => getLogger().info("some-stage", "test")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// US-002 — Resource attribute builder
// ---------------------------------------------------------------------------

describe("US-002: buildResourceAttributes", () => {
  test("AC-14: includes service.name equal to the supplied service name", () => {
    const attrs = buildResourceAttributes({ serviceName: "my-service", runId: "123" });
    const matches = attrs.filter((a) => a.key === "service.name");
    expect(matches).toHaveLength(1);
    expect(matches[0].value.stringValue).toBe("my-service");
  });

  test("AC-15: includes nax.run_id equal to the supplied run identifier", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "run-456" });
    const matches = attrs.filter((a) => a.key === "nax.run_id");
    expect(matches).toHaveLength(1);
    expect(matches[0].value.stringValue).toBe("run-456");
  });

  test("AC-16: includes nax.feature equal to the supplied feature name", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123", feature: "my-feature" });
    const matches = attrs.filter((a) => a.key === "nax.feature");
    expect(matches).toHaveLength(1);
    expect(matches[0].value.stringValue).toBe("my-feature");
  });

  test("AC-17: includes nax.project equal to the supplied project name", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123", project: "my-project" });
    const matches = attrs.filter((a) => a.key === "nax.project");
    expect(matches).toHaveLength(1);
    expect(matches[0].value.stringValue).toBe("my-project");
  });

  test("AC-18: includes nax.version equal to NAX_VERSION", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123" });
    const matches = attrs.filter((a) => a.key === "nax.version");
    expect(matches).toHaveLength(1);
    expect(matches[0].value.stringValue).toBe(NAX_VERSION);
  });

  test("AC-19: includes host.name equal to os.hostname()", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123" });
    const matches = attrs.filter((a) => a.key === "host.name");
    expect(matches).toHaveLength(1);
    expect(matches[0].value.stringValue).toBe(hostname());
  });

  test("AC-20: includes process.pid as a numeric attribute equal to process.pid", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123" });
    const matches = attrs.filter((a) => a.key === "process.pid");
    expect(matches).toHaveLength(1);
    expect(typeof matches[0].value.doubleValue).toBe("number");
    expect(matches[0].value.doubleValue).toBe(process.pid);
  });

  test("AC-21: includes nax.git.branch equal to the supplied branch when supplied", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123", git: { branch: "main" } });
    const matches = attrs.filter((a) => a.key === "nax.git.branch");
    expect(matches).toHaveLength(1);
    expect(matches[0].value.stringValue).toBe("main");
  });

  test("AC-22: includes nax.git.sha equal to the supplied sha when supplied", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123", git: { sha: "abc123" } });
    const matches = attrs.filter((a) => a.key === "nax.git.sha");
    expect(matches).toHaveLength(1);
    expect(matches[0].value.stringValue).toBe("abc123");
  });

  test("AC-23: no nax.git.branch attribute is present when no branch is supplied", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123" });
    expect(findAttr(attrs, "nax.git.branch")).toBeUndefined();
  });

  test("AC-24: no nax.git.sha attribute is present when no sha is supplied", () => {
    const attrs = buildResourceAttributes({ serviceName: "svc", runId: "123" });
    expect(findAttr(attrs, "nax.git.sha")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// US-003 — Resource attribute adoption
// ---------------------------------------------------------------------------

const storySummary = { completed: 1, failed: 0, skipped: 0, paused: 0 };

describe("US-003: resource attribute adoption", () => {
  test("AC-25: buildTracesPayload carries nax.feature on the resource block", () => {
    const input: TracesInput = {
      serviceName: "nax",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startUnixNano: "1000",
      endUnixNano: "2000",
      feature: "my-feature",
      runId: "run-1",
      storySummary,
      totalCost: 0,
      events: [],
    };
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildTracesPayload(input);
    const attrs = payload.resourceSpans[0].resource.attributes as KeyValue[];
    expect(findAttr(attrs, "nax.feature")?.value.stringValue).toBe("my-feature");
  });

  test("AC-26: buildMetricsPayload carries nax.feature on the resource block", () => {
    const input: MetricsInput = {
      serviceName: "nax",
      runId: "run-1",
      timeUnixNano: "1000",
      storySummary,
      totalCost: 0,
      totalDurationMs: 0,
      feature: "my-feature",
    };
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildMetricsPayload(input);
    const attrs = payload.resourceMetrics[0].resource.attributes as KeyValue[];
    expect(findAttr(attrs, "nax.feature")?.value.stringValue).toBe("my-feature");
  });

  test("AC-27: buildHeartbeatMetricsPayload carries nax.run_id on the resource block", () => {
    const input: HeartbeatMetricsInput = {
      serviceName: "nax",
      timeUnixNano: "1000",
      snapshot: {
        attributes: {
          runId: "run-123",
          feature: "my-feature",
          project: "",
          storyId: "",
          phase: "",
          tier: "",
          testStrategy: "",
        },
        phaseElapsedMs: 0,
        costUsd: 0,
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildHeartbeatMetricsPayload(input);
    const attrs = payload.resourceMetrics[0].resource.attributes as KeyValue[];
    expect(findAttr(attrs, "nax.run_id")?.value.stringValue).toBe("run-123");
  });

  test("AC-28: heartbeat gauge datapoints still carry a bare feature attribute", () => {
    const input: HeartbeatMetricsInput = {
      serviceName: "nax",
      timeUnixNano: "1000",
      snapshot: {
        attributes: {
          runId: "run-123",
          feature: "my-feature",
          project: "",
          storyId: "",
          phase: "",
          tier: "",
          testStrategy: "",
        },
        phaseElapsedMs: 5,
        costUsd: 1,
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP payload
    const payload: any = buildHeartbeatMetricsPayload(input);
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics as any[];
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      const dpAttrs = metric.gauge.dataPoints[0].attributes as KeyValue[];
      expect(findAttr(dpAttrs, "feature")?.value.stringValue).toBe("my-feature");
    }
  });

  test("AC-29: the span-tree metrics payload builder carries nax.project on the resource block", () => {
    const aggregator = createPhaseMetricsAggregator();
    const payload: any = aggregator.buildMetricsPayload({
      serviceName: "nax",
      runId: "run-1",
      timeUnixNano: "1000",
      project: "my-project",
    });
    const attrs = payload.resourceMetrics[0].resource.attributes as KeyValue[];
    expect(findAttr(attrs, "nax.project")?.value.stringValue).toBe("my-project");
  });

  test("AC-30: an incremental span-flush request issued before run end carries nax.run_id", async () => {
    const { posts, fetch } = capturingFetch();
    const plugin = createOtelReporterPlugin({ ...baseCfg, maxBatchSize: 1 }, { fetch });
    const r = plugin.extensions.reporter!;

    await r.onRunStart?.({
      runId: "run-456",
      feature: "f",
      totalStories: 1,
      startTime: new Date().toISOString(),
      project: "p",
    });
    await r.onPhaseComplete?.({
      runId: "run-456",
      scope: "story",
      storyId: "s1",
      phase: "implementer",
      outcome: "passed",
      durationMs: 10,
      costUsd: 0.01,
      tier: "fast",
      testStrategy: "tdd-simple",
    });
    await sleep(20);

    const tracePosts = posts.filter((p) => p.url.endsWith("/v1/traces"));
    expect(tracePosts.length).toBeGreaterThan(0);
    const attrs = tracePosts[0].body.resourceSpans[0].resource.attributes as KeyValue[];
    expect(findAttr(attrs, "nax.run_id")?.value.stringValue).toBe("run-456");
  });

  test("AC-31: onRunStart completes without throwing when git resolution rejects", async () => {
    const originalSpawn = _gitDeps.spawn;
    _gitDeps.spawn = () => {
      throw new Error("spawn failed");
    };
    try {
      const { fetch } = capturingFetch();
      const plugin = createOtelReporterPlugin(baseCfg, { fetch });
      const r = plugin.extensions.reporter!;
      await expect(
        r.onRunStart?.({
          runId: "run-git-fail",
          feature: "f",
          totalStories: 1,
          startTime: new Date().toISOString(),
          project: "p",
        }),
      ).resolves.toBeUndefined();
    } finally {
      _gitDeps.spawn = originalSpawn;
    }
  });

  test("AC-32: exported payload carries no nax.git.branch attribute when git branch resolution fails", async () => {
    const originalSpawn = _gitDeps.spawn;
    _gitDeps.spawn = () => {
      throw new Error("git unavailable");
    };
    try {
      const { posts, fetch } = capturingFetch();
      const plugin = createOtelReporterPlugin(baseCfg, { fetch });
      const r = plugin.extensions.reporter!;
      await r.onRunStart?.({
        runId: "run-git-branch-fail",
        feature: "f",
        totalStories: 1,
        startTime: new Date().toISOString(),
        project: "p",
      });
      await r.onRunEnd?.({
        runId: "run-git-branch-fail",
        totalDurationMs: 10,
        totalCost: 0,
        storySummary,
      });
      const tracePosts = posts.filter((p) => p.url.endsWith("/v1/traces"));
      expect(tracePosts.length).toBeGreaterThan(0);
      const attrs = tracePosts[0].body.resourceSpans[0].resource.attributes as KeyValue[];
      expect(findAttr(attrs, "nax.git.branch")).toBeUndefined();
    } finally {
      _gitDeps.spawn = originalSpawn;
    }
  });
});

// ---------------------------------------------------------------------------
// US-004 — LogEntry to LogRecord mapping
// ---------------------------------------------------------------------------

describe("US-004: toLogRecord / buildLogsPayload", () => {
  test("AC-33: timeUnixNano equals the timestamp expressed in nanoseconds", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ timestamp: "2024-01-15T10:30:00.000Z" }));
    expect(record.timeUnixNano).toBe("1705314600000000000");
  });

  test("AC-34: level error maps to severityNumber 17", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ level: "error" }));
    expect(record.severityNumber).toBe(17);
  });

  test("AC-35: level error maps to severityText ERROR", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ level: "error" }));
    expect(record.severityText).toBe("ERROR");
  });

  test("AC-36: level warn maps to severityNumber 13", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ level: "warn" }));
    expect(record.severityNumber).toBe(13);
  });

  test("AC-37: level info maps to severityNumber 9", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ level: "info" }));
    expect(record.severityNumber).toBe(9);
  });

  test("AC-38: level debug maps to severityNumber 5", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ level: "debug" }));
    expect(record.severityNumber).toBe(5);
  });

  test("AC-39: message maps to body.stringValue", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ message: "test message" }));
    expect(record.body.stringValue).toBe("test message");
  });

  test("AC-40: stage maps to attribute nax.stage", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ stage: "implementation" }));
    expect(findAttr(record.attributes, "nax.stage")?.value.stringValue).toBe("implementation");
  });

  test("AC-41: storyId maps to attribute nax.story_id", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ storyId: "abc-123" }));
    expect(findAttr(record.attributes, "nax.story_id")?.value.stringValue).toBe("abc-123");
  });

  test("AC-42: no nax.story_id attribute is present when storyId is absent", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry());
    expect(findAttr(record.attributes, "nax.story_id")).toBeUndefined();
  });

  test("AC-43: sessionRole maps to attribute nax.session_role", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ sessionRole: "agent" }));
    expect(findAttr(record.attributes, "nax.session_role")?.value.stringValue).toBe("agent");
  });

  test("AC-44: top-level string data value maps to attribute nax.data.<key>", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ data: { phase: "testing" } }));
    expect(findAttr(record.attributes, "nax.data.phase")?.value.stringValue).toBe("testing");
  });

  test("AC-45: top-level numeric data value maps to attribute nax.data.<key> as a numeric attribute", () => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ data: { count: 42 } }));
    expect(findAttr(record.attributes, "nax.data.count")?.value.doubleValue).toBe(42);
  });

  test("AC-46: nested data value maps to attribute nax.data_json as valid JSON containing the nested content", () => {
    const findings = [{ id: 1, severity: "high" }];
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ data: { findings } }));
    const raw = findAttr(record.attributes, "nax.data_json")?.value.stringValue;
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string);
    expect(parsed.findings).toEqual(findings);
  });

  test("AC-47: nax.data_json is truncated to at most 2048 characters with a trailing marker when data exceeds it", () => {
    const bigData = { nested: { big: "x".repeat(3000) } };
    // biome-ignore lint/suspicious/noExplicitAny: dynamic OTLP record
    const record: any = toLogRecord(makeEntry({ data: bigData }));
    const raw = findAttr(record.attributes, "nax.data_json")?.value.stringValue as string;
    expect(raw.length).toBeLessThanOrEqual(2048);
    expect(raw.includes("...[truncated]")).toBe(true);
  });

  test("AC-48: buildLogsPayload result carries a non-empty nax.feature resource attribute", () => {
    const payload: any = buildLogsPayload([makeEntry()], {
      serviceName: "nax",
      runId: "run-1",
      feature: "my-feature",
    });
    const featureAttr = findAttr(payload.resourceLogs[0].resource.attributes, "nax.feature");
    expect(featureAttr?.value.stringValue).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// US-005 — Exporter wiring and lifecycle
// ---------------------------------------------------------------------------

type SinkFn = (entry: LogEntry) => void;

function capturingWithAddSink() {
  const { posts, fetch } = capturingFetch();
  const sinkCalls: SinkFn[] = [];
  const deps = {
    fetch,
    addSink: (fn: SinkFn) => {
      sinkCalls.push(fn);
      return () => {
        const idx = sinkCalls.indexOf(fn);
        if (idx >= 0) sinkCalls.splice(idx, 1);
      };
    },
  };
  return { posts, sinkCalls, deps };
}

function logsPosts(posts: Array<{ url: string; body: any; raw: string }>) {
  return posts.filter((p) => p.url.endsWith("/v1/logs"));
}

describe("US-005: exporter wiring and lifecycle", () => {
  test("AC-49: reporter configuration resolves logs.enabled to false when unset", () => {
    const cfg = OtelReporterConfigSchema.parse({});
    // biome-ignore lint/suspicious/noExplicitAny: prospective logs config field
    expect((cfg as any).logs.enabled).toBe(false);
  });

  test("AC-50: reporter configuration resolves logs.level to \"info\" when unset", () => {
    const cfg = OtelReporterConfigSchema.parse({});
    // biome-ignore lint/suspicious/noExplicitAny: prospective logs config field
    expect((cfg as any).logs.level).toBe("info");
  });

  test("AC-51: onRunStart does not invoke addSink when logs.enabled is false", async () => {
    const { sinkCalls, deps } = capturingWithAddSink();
    const cfg = { ...baseCfg, logs: { enabled: false, level: "info" } } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r1", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    expect(sinkCalls).toHaveLength(0);
  });

  test("AC-52: onRunStart invokes addSink exactly once when logs.enabled is true", async () => {
    const { sinkCalls, deps } = capturingWithAddSink();
    const cfg = { ...baseCfg, logs: { enabled: true, level: "info" } } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r2", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    expect(sinkCalls).toHaveLength(1);
  });

  test("AC-53: a sub-floor info entry results in zero posted log records when logs.level is warn", async () => {
    const { posts, sinkCalls, deps } = capturingWithAddSink();
    const cfg = {
      ...baseCfg,
      maxBatchSize: 1,
      logs: { enabled: true, level: "warn" },
    } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r3", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "some-stage", message: "below floor" });
    await sleep(20);
    expect(logsPosts(posts)).toHaveLength(0);
  });

  test("AC-54: a warn-level entry is posted with severityText WARN when logs.level is warn", async () => {
    const { posts, sinkCalls, deps } = capturingWithAddSink();
    const cfg = {
      ...baseCfg,
      maxBatchSize: 1,
      logs: { enabled: true, level: "warn" },
    } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r4", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "warn", stage: "some-stage", message: "at floor" });
    await sleep(20);
    const lp = logsPosts(posts);
    expect(lp).toHaveLength(1);
    const record = lp[0].body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.severityText).toBe("WARN");
  });

  test("AC-55: a log entry whose stage is otel-batch-queue results in zero posted log records", async () => {
    const { posts, sinkCalls, deps } = capturingWithAddSink();
    const cfg = {
      ...baseCfg,
      maxBatchSize: 1,
      logs: { enabled: true, level: "info" },
    } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r5", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    sinkCalls[0]({
      timestamp: new Date().toISOString(),
      level: "warn",
      stage: "otel-batch-queue",
      message: "batch export threw",
    });
    await sleep(20);
    expect(logsPosts(posts)).toHaveLength(0);
  });

  test("AC-56: a flushed log entry is posted to /v1/logs with the logged message as the record body", async () => {
    const { posts, sinkCalls, deps } = capturingWithAddSink();
    const cfg = {
      ...baseCfg,
      maxBatchSize: 1,
      logs: { enabled: true, level: "info" },
    } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r6", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "no test command" });
    await sleep(20);
    const lp = logsPosts(posts);
    expect(lp).toHaveLength(1);
    expect(lp[0].url.endsWith("/v1/logs")).toBe(true);
    expect(lp[0].raw).toMatch(/\[\{"body":\{"stringValue":"no test command"/);
  });

  test("AC-57: every logs-export POST targets a URL pathname ending with /v1/logs", async () => {
    const { posts, sinkCalls, deps } = capturingWithAddSink();
    const cfg = {
      ...baseCfg,
      maxBatchSize: 1,
      logs: { enabled: true, level: "info" },
    } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r7", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "entry-a" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "entry-b" });
    await sleep(20);
    const lp = logsPosts(posts);
    expect(lp.length).toBeGreaterThan(0);
    for (const p of lp) {
      expect(new URL(p.url).pathname.endsWith("/v1/logs")).toBe(true);
    }
  });

  test("AC-58: onRunEnd posts a single request containing every queued log record", async () => {
    const { posts, sinkCalls, deps } = capturingWithAddSink();
    const cfg = {
      ...baseCfg,
      maxBatchSize: 64,
      logs: { enabled: true, level: "info" },
    } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r8", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "e1" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "e2" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "e3" });
    await r.onRunEnd?.({ runId: "r8", totalDurationMs: 10, totalCost: 0, storySummary });
    await sleep(20);
    const lp = logsPosts(posts);
    expect(lp).toHaveLength(1);
    expect(lp[0].body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(3);
  });

  test("AC-59: teardown after onRunEnd posts no further logs requests", async () => {
    const { posts, sinkCalls, deps } = capturingWithAddSink();
    const cfg = {
      ...baseCfg,
      maxBatchSize: 64,
      logs: { enabled: true, level: "info" },
    } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r9", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "e1" });
    await r.onRunEnd?.({ runId: "r9", totalDurationMs: 10, totalCost: 0, storySummary });
    await sleep(20);
    const countAfterRunEnd = logsPosts(posts).length;
    expect(countAfterRunEnd).toBeGreaterThan(0);
    await plugin.teardown?.();
    await sleep(20);
    expect(logsPosts(posts)).toHaveLength(countAfterRunEnd);
  });

  test("AC-60: an unresolved header env var results in no logs POST for a queued entry", async () => {
    const { posts, sinkCalls, deps } = capturingWithAddSink();
    delete process.env.NAX_OTLP_LOGS_TEST_UNSET_VAR;
    const cfg = {
      ...baseCfg,
      maxBatchSize: 1,
      headers: { Authorization: "Bearer ${NAX_OTLP_LOGS_TEST_UNSET_VAR}" },
      logs: { enabled: true, level: "info" },
    } as unknown as OtelReporterConfig;
    const plugin = createOtelReporterPlugin(cfg, deps as any);
    const r = plugin.extensions.reporter!;
    await r.onRunStart?.({ runId: "r10", feature: "f", totalStories: 1, startTime: new Date().toISOString(), project: "p" });
    sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "e1" });
    await sleep(20);
    expect(logsPosts(posts)).toHaveLength(0);
  });

  test("AC-61: the warning for an unresolved header env var names the missing variable", async () => {
    await withWarnSpy(async (warnSpy) => {
      const { sinkCalls, deps } = capturingWithAddSink();
      delete process.env.NAX_OTLP_LOGS_TEST_MISSING_VAR;
      const cfg = {
        ...baseCfg,
        maxBatchSize: 1,
        headers: { Authorization: "Bearer ${NAX_OTLP_LOGS_TEST_MISSING_VAR}" },
        logs: { enabled: true, level: "info" },
      } as unknown as OtelReporterConfig;
      const plugin = createOtelReporterPlugin(cfg, deps as any);
      const r = plugin.extensions.reporter!;
      await r.onRunStart?.({
        runId: "r11",
        feature: "f",
        totalStories: 1,
        startTime: new Date().toISOString(),
        project: "p",
      });
      sinkCalls[0]({ timestamp: new Date().toISOString(), level: "info", stage: "verify", message: "e1" });
      await sleep(20);

      const relevant = warnSpy.mock.calls.filter((c) =>
        JSON.stringify(c).includes("NAX_OTLP_LOGS_TEST_MISSING_VAR"),
      );
      expect(relevant.length).toBeGreaterThan(0);
    });
  });
});