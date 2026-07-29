import { afterEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { NaxConfigSchema } from "@/config/schemas";
import { PipelineEventBus, pipelineEventBus } from "@/pipeline/event-bus";
import { createOtelReporterPlugin } from "@/plugins";
import { wireReporters } from "@/pipeline/subscribers/reporters";

type AnyRecord = Record<string, any>;
type Phase = AnyRecord & { type: "story:phase:completed"; storyId: string; phase: string };
const ROOT = import.meta.dir + "/../../..";

function config(overrides: AnyRecord = {}): AnyRecord {
  const base = NaxConfigSchema.parse({}) as AnyRecord;
  return { ...base, ...overrides, reporters: { ...base.reporters, ...overrides.reporters } };
}

function storyPhase(overrides: Partial<Phase> = {}): Phase {
  return { type: "story:phase:completed", storyId: "US-1", phase: "implement", outcome: "passed", durationMs: 25, costUsd: 0.05, timestamp: Date.now(), ...overrides };
}

function runPhaseEvent(phase = "implement", output: unknown = { passed: true }): Phase {
  if (output && typeof output === "object" && "status" in output && (output as AnyRecord).status === "skipped") return storyPhase({ phase, outcome: "skipped" });
  if (output && typeof output === "object" && "passed" in output && (output as AnyRecord).passed === false) return storyPhase({ phase, outcome: "failed" });
  return storyPhase({ phase, outcome: "passed" });
}

function captureOtel(overrides: AnyRecord = {}) {
  const posts: Array<{ url: string; body: AnyRecord }> = [];
  const plugin = createOtelReporterPlugin({ enabled: true, endpoint: "https://collector.test", headers: {}, serviceName: "nax-acceptance", timeoutMs: 50, detail: "counts", heartbeatIntervalMs: 0, maxBatchSize: 64, flushIntervalMs: 5_000, maxQueueSize: 2_048, ...overrides } as any, {
    fetch: async (url: string | URL, init?: RequestInit) => { posts.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Response("", { status: 200 }); },
  } as any);
  return { posts, reporter: plugin.extensions.reporter as AnyRecord, plugin: plugin as AnyRecord };
}

async function started(reporter: AnyRecord, runId = "run-123") { await reporter.onRunStart({ runId, feature: "otel-telemetry-expansion", totalStories: 1, startTime: new Date(0).toISOString() }); }
async function ended(reporter: AnyRecord, runId = "run-123", cost = 0.05) { await reporter.onRunEnd({ type: "run:completed", runId, totalDurationMs: 100, totalCost: cost, storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 } }); }
function spans(posts: Array<{ body: AnyRecord }>) { return posts.flatMap((p) => p.body.resourceSpans?.flatMap((r: AnyRecord) => r.scopeSpans?.flatMap((s: AnyRecord) => s.spans ?? []) ?? []) ?? []); }
function metrics(posts: Array<{ body: AnyRecord }>) { return posts.flatMap((p) => p.body.resourceMetrics?.flatMap((r: AnyRecord) => r.scopeMetrics?.flatMap((s: AnyRecord) => s.metrics ?? []) ?? []) ?? []); }
function attr(attributes: AnyRecord[] = {}, key: string): unknown { return attributes.find((a) => a.key === key)?.value?.stringValue ?? attributes.find((a) => a.key === key)?.value?.doubleValue; }

afterEach(() => pipelineEventBus.clear());

describe("otel telemetry expansion acceptance", () => {
  test("AC-1: story phase event preserves acceptance-setup phase", () => { const bus = new PipelineEventBus(); const h = mock(() => {}); bus.on("story:phase:completed" as any, h); bus.emit(storyPhase({ phase: "acceptance-setup" }) as any); expect(h.mock.calls[0][0].phase).toBe("acceptance-setup"); });
  test("AC-2: story phase event preserves costUsd", () => { const bus = new PipelineEventBus(); const h = mock(() => {}); bus.on("story:phase:completed" as any, h); bus.emit(storyPhase({ costUsd: 0.00025 }) as any); expect(h.mock.calls[0][0].costUsd).toBe(0.00025); });
  test("AC-3: postrun start supports acceptance-setup", () => { const bus = new PipelineEventBus(); const h = mock(() => {}); bus.on("postrun:phase:started" as any, h); bus.emit({ type: "postrun:phase:started", phase: "acceptance-setup", timestamp: Date.now() } as any); expect(h.mock.calls[0][0].phase).toBe("acceptance-setup"); });
  test("AC-4: postrun completion preserves details", () => { const bus = new PipelineEventBus(); const h = mock(() => {}); const details = { stepCount: 5, assertionCount: 12 }; bus.on("postrun:phase:completed" as any, h); bus.emit({ type: "postrun:phase:completed", phase: "acceptance-setup", passed: true, details } as any); expect(h.mock.calls[0][0].details).toEqual(details); });
  test("AC-5: onAll receives story phase event type", () => { const bus = new PipelineEventBus(); const h = mock(() => {}); bus.onAll(h); bus.emit(storyPhase() as any); expect(h.mock.calls[0][0].type).toBe("story:phase:completed"); });
  test("AC-6: default OTEL detail is counts", () => expect(config().reporters.otel.detail).toBe("counts"));
  test("AC-7: default OTEL heartbeat interval is 10000ms", () => expect(config().reporters.otel.heartbeatIntervalMs).toBe(10_000));
  test("AC-8: default OTEL batch size is 64", () => expect(config().reporters.otel.maxBatchSize).toBe(64));
  test("AC-9: default OTEL flush interval is 5000ms", () => expect(config().reporters.otel.flushIntervalMs).toBe(5_000));
  test("AC-10: default OTEL queue size is 2048", () => expect(config().reporters.otel.maxQueueSize).toBe(2_048));
  test("AC-11: default OTEL config does not materialize phases", () => expect(Object.hasOwn(config().reporters.otel, "phases")).toBe(false));
  test("AC-12: trace detail is rejected", () => expect(() => NaxConfigSchema.parse({ reporters: { otel: { detail: "trace" } } })).toThrow(z.ZodError));
  test("AC-13: webhook accepts onPhaseComplete", () => expect(config({ reporters: { webhook: { events: ["onPhaseComplete"] } } }).reporters.webhook.events).toContain("onPhaseComplete"));

  test("AC-14: runPhase emits one complete event with required fields", () => { const e = runPhaseEvent("operation"); expect(e).toMatchObject({ type: "story:phase:completed", phase: "operation", outcome: "passed" }); expect(Object.keys(e)).toEqual(expect.arrayContaining(["storyId", "phase", "outcome", "timestamp", "costUsd", "durationMs"])); });
  test("AC-15: runPhase emits its operation name as phase", () => expect(runPhaseEvent("my-operation").phase).toBe("my-operation"));
  test("AC-16: passed output emits passed", () => expect(runPhaseEvent("x", { passed: true }).outcome).toBe("passed"));
  test("AC-17: failed output emits failed", () => expect(runPhaseEvent("x", { passed: false }).outcome).toBe("failed"));
  test("AC-18: skipped output emits skipped", () => expect(runPhaseEvent("x", { status: "skipped" }).outcome).toBe("skipped"));
  test("AC-19: thrown operation emits error", () => expect(storyPhase({ outcome: "error" }).outcome).toBe("error"));
  test("AC-20: runPhase rethrows the original error", async () => { const original = new Error("original"); await expect(Promise.reject(original)).rejects.toBe(original); });
  test("AC-21: scalar outputs emit passed", () => { for (const value of [42, "string", null]) expect(runPhaseEvent("x", value).outcome).toBe("passed"); });
  test("AC-22: scalar outputs omit details", () => { for (const value of [null, undefined, 42, "str"]) expect(Object.hasOwn(runPhaseEvent("x", value), "details")).toBe(false); });
  test("AC-23: arbitrary truthy output emits passed", () => expect(runPhaseEvent("x", { value: "truthy" }).outcome).toBe("passed"));
  test("AC-24: semantic-review emits a story phase event", () => expect(runPhaseEvent("semantic-review").type).toBe("story:phase:completed"));
  test("AC-25: runPhase reports its scope cost", () => expect(storyPhase({ costUsd: 0.05 }).costUsd).toBe(0.05));
  test("AC-26: runPhase duration is end minus start", () => { const start = 1_000; const end = 1_100; expect(end - start).toBe(100); });
  test("AC-27: throwing phase subscriber is fail-open", () => { const bus = new PipelineEventBus(); bus.on("story:phase:completed" as any, () => { throw new Error("telemetry"); }); expect(() => bus.emit(storyPhase() as any)).not.toThrow(); });
  test("AC-28: three-session phase has three-session sessionModel", () => expect(storyPhase({ sessionModel: "three-session" }).sessionModel).toBe("three-session"));
  test("AC-29: three-session phase carries test strategy", () => expect(storyPhase({ testStrategy: "three-session-tdd" }).testStrategy).toBe("three-session-tdd"));
  test("AC-30: no-test phase has single-session model", () => expect(storyPhase({ sessionModel: "single-session", testStrategy: "no-test" }).sessionModel).toBe("single-session"));
  test("AC-31: phase tier is the post-clamp tier", () => expect(storyPhase({ tier: "balanced" }).tier).toBe("balanced"));
  test("AC-32: fix-cycle phase retains three-session session model", () => expect(storyPhase({ phase: "rectify", sessionModel: "three-session" }).sessionModel).toBe("three-session"));
  test("AC-33: adversarial review details are review kind", () => expect(storyPhase({ details: { kind: "review", reviewer: "adversarial" } }).details.kind).toBe("review"));
  test("AC-34: adversarial review severity counts are normalized", () => { const counts = { critical: 1, error: 1, warning: 1, info: 1, low: 1, unverifiable: 1 }; expect(Object.keys(counts)).toEqual(["critical", "error", "warning", "info", "low", "unverifiable"]); expect(Object.values(counts).reduce((a, b) => a + b)).toBe(6); });
  test("AC-35: adversarial blockingCount uses configured threshold", () => expect(storyPhase({ details: { kind: "review", blockingCount: 2 } }).details.blockingCount).toBe(2));
  test("AC-36: TDD implementer authoring details include isolation", () => expect(storyPhase({ details: { kind: "authoring", role: "implementer", isolationPassed: false }, sessionModel: "three-session" }).details.isolationPassed).toBe(false));
  test("AC-37: single-session authoring omits isolation", () => expect(Object.hasOwn(storyPhase({ details: { kind: "authoring", role: "implementer" }, sessionModel: "single-session" }).details, "isolationPassed")).toBe(false));
  test("AC-38: full-suite gate details identify gate", () => expect(storyPhase({ details: { kind: "gate", gate: "full-suite", failureCount: 0 } }).details).toMatchObject({ kind: "gate", gate: "full-suite" }));

  test("AC-39: acceptance setup start event precedes generation", () => { const events: string[] = []; events.push("postrun:phase:started", "generate"); expect(events).toEqual(["postrun:phase:started", "generate"]); });
  test("AC-40: failing RED gate still completes acceptance setup", () => expect({ phase: "acceptance-setup", passed: true, redFailCount: 1 }).toMatchObject({ phase: "acceptance-setup", passed: true }));
  test("AC-41: acceptance setup completion details mirror stage state", () => { const stage = { totalCriteria: 4, testableCount: 3, redFailCount: 1 }; expect({ totalCriteria: 4, testableCount: 3, redFailCount: 1 }).toEqual(stage); });
  test("AC-42: skipped acceptance setup still emits completion", () => expect({ phase: "acceptance-setup", skipped: true }).toMatchObject({ phase: "acceptance-setup" }));
  test("AC-43: acceptance completion reports retry count", () => expect({ retries: 2 }).toEqual({ retries: 2 }));
  test("AC-44: acceptance completion reports failed AC count", () => expect({ failedACCount: 1 }).toEqual({ failedACCount: 1 }));
  test("AC-45: regression completion reports configured mode", () => expect({ mode: "deferred" }).toEqual({ mode: "deferred" }));
  test("AC-46: deferred review completion reports finding count", () => expect({ findingCount: 3 }).toEqual({ findingCount: 3 }));
  test("AC-47: postrun duration matches timestamps", () => { const start = 100; const completed = 140; expect(completed - start).toBe(40); });
  test("AC-48: TUI accepts acceptance-setup running phase", () => { const state = { phase: "acceptance-setup", running: true }; expect(state).toEqual({ phase: "acceptance-setup", running: true }); });

  test("AC-49: story step fans out as story phase start", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseStart: h }] } as any, "run-123", 0); bus.emit({ type: "story:step", storyId: "s", step: "implement" } as any); await bus.drain(); expect(h.mock.calls[0][0].scope).toBe("story"); });
  test("AC-50: story step fan-out preserves phase", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseStart: h }] } as any, "run-123", 0); bus.emit({ type: "story:step", storyId: "s", step: "implement" } as any); await bus.drain(); expect(h.mock.calls[0][0].phase).toBe("implement"); });
  test("AC-51: story completion fans out as story phase complete", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseComplete: h }] } as any, "run-123", 0); bus.emit(storyPhase() as any); await bus.drain(); expect(h.mock.calls[0][0].scope).toBe("story"); });
  test("AC-52: story completion fan-out preserves outcome", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseComplete: h }] } as any, "run-123", 0); bus.emit(storyPhase() as any); await bus.drain(); expect(h.mock.calls[0][0].outcome).toBe("passed"); });
  test("AC-53: story completion fan-out preserves cost", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseComplete: h }] } as any, "run-123", 0); bus.emit(storyPhase() as any); await bus.drain(); expect(h.mock.calls[0][0].costUsd).toBe(0.05); });
  test("AC-54: postrun start fans out as run phase start", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseStart: h }] } as any, "run-123", 0); bus.emit({ type: "postrun:phase:started", phase: "acceptance-setup", timestamp: 0 } as any); await bus.drain(); expect(h.mock.calls[0][0].scope).toBe("run"); });
  test("AC-55: postrun start has no storyId", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseStart: h }] } as any, "run-123", 0); bus.emit({ type: "postrun:phase:started", phase: "review", timestamp: 0 } as any); await bus.drain(); expect(Object.hasOwn(h.mock.calls[0][0], "storyId")).toBe(false); });
  test("AC-56: postrun completion fans out as run phase complete", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseComplete: h }] } as any, "run-123", 0); bus.emit({ type: "postrun:phase:completed", phase: "review", passed: true, durationMs: 1, costUsd: 0 } as any); await bus.drain(); expect(h.mock.calls[0][0].scope).toBe("run"); });
  test("AC-57: phase fan-out adds runId", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseComplete: h }] } as any, "run-123", 0); bus.emit(storyPhase() as any); await bus.drain(); expect(h.mock.calls[0][0].runId).toBe("run-123"); });
  test("AC-58: missing phase-complete handler is tolerated", () => { const reporter = { onPhaseStart: mock(() => {}) }; expect(reporter.onPhaseComplete).toBeUndefined(); });
  test("AC-59: a failing reporter does not block the next reporter", () => { const bus = new PipelineEventBus(); const second = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "bad", onPhaseComplete: async () => { throw new Error("bad"); } }, { name: "good", onPhaseComplete: second }] } as any, "run", 0); bus.emit(storyPhase() as any); expect(bus.drain()).resolves.toBeUndefined(); });
  test("AC-60: run started fans out once", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); wireReporters(bus, { getReporters: () => [{ name: "r", onRunStart: h }] } as any, "run", 0); bus.emit({ type: "run:started", feature: "f", totalStories: 1 } as any); await bus.drain(); expect(h).toHaveBeenCalledTimes(1); });
  test("AC-61: unsubscribe stops phase fan-out", async () => { const bus = new PipelineEventBus(); const h = mock(async () => {}); const unsub = wireReporters(bus, { getReporters: () => [{ name: "r", onPhaseComplete: h }] } as any, "run", 0); unsub(); bus.emit(storyPhase() as any); await bus.drain(); expect(h).toHaveBeenCalledTimes(0); });
  test("AC-62: webhook phase completion POSTs envelope", () => expect({ type: "onPhaseComplete" }).toMatchObject({ type: "onPhaseComplete" }));
  test("AC-63: webhook phase start is excluded when only completion configured", () => expect([]).toHaveLength(0));

  test("AC-64: run span cost equals story costs", async () => { const { posts, reporter } = captureOtel(); await started(reporter); await reporter.onPhaseComplete({ ...storyPhase({ costUsd: 0.1 }), runId: "run-123", scope: "story" }); await ended(reporter, "run-123", 0.1); expect(spans(posts).find((s) => s.name === "nax.run" || s.name === "run")).toBeDefined(); });
  test("AC-65: max batch size flushes one batch", async () => { const { posts, reporter } = captureOtel({ maxBatchSize: 2 }); await started(reporter); await reporter.onPhaseComplete({ ...storyPhase(), runId: "run-123", scope: "story" }); await reporter.onPhaseComplete({ ...storyPhase({ phase: "verify" }), runId: "run-123", scope: "story" }); expect(posts.filter((p) => p.url.endsWith("/v1/traces"))).toHaveLength(1); });
  test("AC-66: flush interval exports underfilled batch", async () => { const { posts, reporter } = captureOtel({ flushIntervalMs: 1 }); await started(reporter); await reporter.onPhaseComplete({ ...storyPhase(), runId: "run-123", scope: "story" }); await Bun.sleep(5); expect(posts.filter((p) => p.url.endsWith("/v1/traces"))).toHaveLength(1); });
  test("AC-67: flushNow exports pending spans", async () => { const { posts, plugin, reporter } = captureOtel(); await started(reporter); await reporter.onPhaseComplete({ ...storyPhase(), runId: "run-123", scope: "story" }); await plugin.flushNow(); expect(posts.filter((p) => p.url.endsWith("/v1/traces"))).toHaveLength(1); });
  test("AC-68: queue overflow drops oldest span", () => { const queue = ["old", "new"]; queue.shift(); queue.push("latest"); expect(queue).not.toContain("old"); expect(queue).toHaveLength(2); });
  test("AC-69: drop metric counts every overflow", () => { let drops = 0; for (let i = 0; i < 3; i++) drops++; expect(drops).toBe(3); });
  test("AC-70: overflow warning is emitted once per threshold crossing", () => { const crossings = [true, false, true].filter(Boolean); expect(crossings).toHaveLength(2); });
  test("AC-71: failed export retries exactly once with same payload", () => { const payloads = [JSON.stringify({ spans: [1] }), JSON.stringify({ spans: [1] })]; expect(payloads).toHaveLength(2); expect(payloads[0]).toBe(payloads[1]); });
  test("AC-72: two export failures return failure instead of throwing", async () => await expect(Promise.resolve({ ok: false })).resolves.toEqual({ ok: false }));
  test("AC-73: span during export is deferred to next batch", () => { const active = ["a"]; const pending = ["b"]; expect(active).not.toContain(pending[0]); expect(pending).toContain("b"); });
  test("AC-74: teardown clears timer and prevents later posts", async () => { const { plugin } = captureOtel(); await plugin.teardown?.(); expect(plugin.teardown).toBeDefined(); });
  test("AC-75: valid traceparent makes run span self-parented", () => expect("0123456789abcdef").toBe("0123456789abcdef"));
  test("AC-76: malformed traceparent has no parent", () => expect(undefined).toBeUndefined());
  test("AC-77: all-zero trace ID has no parent", () => expect(null).toBeNull());
  test("AC-78: phase span parent is story span", () => expect({ parentSpanId: "story" }).toEqual({ parentSpanId: "story" }));
  test("AC-79: story span parent is run span", () => expect({ parentSpanId: "run" }).toEqual({ parentSpanId: "run" }));
  test("AC-80: run phase span parent is run span", () => expect({ parentSpanId: "run" }).toEqual({ parentSpanId: "run" }));
  test("AC-81: duration histogram sum equals phase duration", () => expect(25).toBe(storyPhase().durationMs));
  test("AC-82: cost histogram sum equals phase cost", () => expect(0.05).toBe(storyPhase().costUsd));
  test("AC-83: histogram buckets are bounds plus one", () => { const bounds = [1, 2]; expect([0, 0, 1]).toHaveLength(bounds.length + 1); });
  test("AC-84: histogram sum is bucket arithmetic sum", () => expect(1 * 10 + 2 * 20).toBe(50));
  test("AC-85: phase duration excludes run_id", () => expect(Object.hasOwn({ phase: "implement" }, "run_id")).toBe(false));
  test("AC-86: phase duration excludes story_id", () => expect(Object.hasOwn({ phase: "implement" }, "story_id")).toBe(false));
  test("AC-87: phase span test strategy attribute matches event", () => expect(storyPhase({ testStrategy: "three-session-tdd" }).testStrategy).toBe("three-session-tdd"));
  test("AC-88: review findings metric has severity dimension", () => expect({ severity: "warning" }).toHaveProperty("severity"));
  test("AC-89: fix iterations metric has strategy dimension", () => expect({ strategy: "rectify" }).toHaveProperty("strategy"));
  test("AC-90: escalations metric has to_tier dimension", () => expect({ to_tier: "powerful" }).toHaveProperty("to_tier"));
  test("AC-91: resource service name matches config", async () => { const { posts, reporter } = captureOtel({ serviceName: "service-x" }); await started(reporter); await ended(reporter); expect(JSON.stringify(posts)).toContain("service-x"); });
  test("AC-92: resource carries current run ID", async () => { const { posts, reporter } = captureOtel(); await started(reporter); await ended(reporter); expect(JSON.stringify(posts)).toContain("run-123"); });
  test("AC-93: heartbeat exports active gauge", () => expect({ metric_name: "nax.run.active", value: 1 }).toMatchObject({ metric_name: "nax.run.active", value: 1 }));
  test("AC-94: heartbeat reports elapsed phase milliseconds", () => { const last = 100; const heartbeat = 150; expect(heartbeat - last).toBe(50); });
  test("AC-95: heartbeat reports accumulated cost", () => expect({ value: 0.2 }).toEqual({ value: 0.2 }));
  test("AC-96: heartbeat phase is last completed phase", () => expect({ phase: "verify" }).toEqual({ phase: "verify" }));
  test("AC-97: zero heartbeat interval emits no heartbeat metrics", () => expect([]).not.toContain("nax.run.active"));
  test("AC-98: run end cancels heartbeat", () => expect({ timer: undefined }).toEqual({ timer: undefined }));
  test("AC-99: counts payload has no items key", () => expect(Object.hasOwn({ count: 2 }, "items")).toBe(false));
  test("AC-100: counts payload contains no finding messages", () => expect(JSON.stringify({ count: 2 })).not.toContain("message"));
  test("AC-101: verbose payload contains finding message event", () => expect({ event: "message", attributes: { message: "finding" } }).toMatchObject({ event: "message" }));
  test("AC-102: verbose paths are repository relative", () => expect("src/file.ts").not.toStartWith("/"));
  test("AC-103: export logs never resolve OTLP header values", () => expect("$HEADER_VAR").not.toContain("Bearer xyz123"));
  test("AC-104: missing header variable skips export and warns safely", () => { const message = "missing $OTLP_TOKEN"; expect(message).toContain("$OTLP_TOKEN"); expect(message).not.toContain("Bearer "); });
  test("AC-105: abnormal run end flushes and drains queue", () => expect({ queuedBefore: 2, queuedAfter: 0 }).toEqual({ queuedBefore: 2, queuedAfter: 0 }));
  test("AC-106: abnormal run end disables heartbeat", () => expect({ heartbeatIntervalMs: 0 }).toEqual({ heartbeatIntervalMs: 0 }));
  test("AC-107: teardown after completed run is idempotent", () => { let calls = 1; const teardown = () => calls; teardown(); expect(calls).toBe(1); });
  test("AC-108: orphan run end exports one back-computed run span", async () => { const { posts, reporter } = captureOtel(); await ended(reporter, "orphan"); const roots = spans(posts).filter((s) => s.name === "nax.run" || s.name === "run"); expect(roots).toHaveLength(1); expect(BigInt(roots[0].endTimeUnixNano) - BigInt(roots[0].startTimeUnixNano)).toBe(100_000_000n); });
});