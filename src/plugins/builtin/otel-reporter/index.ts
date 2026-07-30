import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { getSafeLogger } from "@/logger";
import type { IReporter, NaxPlugin, RunEndEvent } from "@/plugins/types";
import { type PostJsonDeps, interpolateHeaders, postJson } from "../reporter-shared";
import { type Heartbeat, type HeartbeatSnapshot, buildHeartbeatMetricsPayload, startHeartbeat } from "./heartbeat";
import { newSpanId, newTraceId } from "./ids";
import { type SpanEvent, attr, buildMetricsPayload, buildTracesPayload, msToUnixNano } from "./otlp";
import { type Span, type SpanTree, createSpanTree } from "./span-tree";
import { parseTraceparent } from "./traceparent";

const STAGE = "otel-reporter";

interface LastPhase {
  phase: string;
  storyId: string;
  tier: string;
  testStrategy: string;
  atMs: number;
}

interface RunState {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  feature: string;
  project: string;
  events: SpanEvent[];
  spanTree: SpanTree;
  phaseSpans: Span[];
  costUsd: number;
  lastPhase?: LastPhase;
  heartbeat: Heartbeat;
}

/** Root span identity: adopts the W3C TRACEPARENT env var when valid, else starts a new root trace. */
function rootSpanIdentity(): { traceId: string; spanId: string; parentSpanId?: string } {
  const adopted = parseTraceparent(process.env.TRACEPARENT);
  if (!adopted) return { traceId: newTraceId(), spanId: newSpanId() };
  return { traceId: adopted.traceId, spanId: newSpanId(), parentSpanId: adopted.spanId };
}

/** Best-effort run state for an `onRunEnd` with no preceding `onRunStart` (US-008 AC16). */
function buildOrphanState(startMs: number): RunState {
  const identity = rootSpanIdentity();
  return {
    ...identity,
    startMs,
    feature: "",
    project: "",
    events: [],
    spanTree: createSpanTree(identity.traceId, identity.spanId),
    phaseSpans: [],
    costUsd: 0,
    heartbeat: { stop() {} },
  };
}

function heartbeatSnapshotOf(runId: string, st: RunState): HeartbeatSnapshot {
  const last = st.lastPhase;
  return {
    attributes: {
      runId,
      feature: st.feature,
      project: st.project,
      storyId: last?.storyId ?? "",
      phase: last?.phase ?? "",
      tier: last?.tier ?? "",
      testStrategy: last?.testStrategy ?? "",
    },
    phaseElapsedMs: last ? Date.now() - last.atMs : 0,
    costUsd: st.costUsd,
  };
}

/**
 * Span events for a review phase's findings. `items` is only ever populated
 * upstream when `detail: "verbose"` (US-003), but the reporter re-checks
 * `verbose` itself here rather than trusting that gate alone — a defense
 * against AC9 (no finding message under "counts") if the upstream gate ever
 * has a bug.
 */
function reviewSpanEvents(details: unknown, timeUnixNano: string, verbose: boolean): SpanEvent[] {
  if (!verbose) return [];
  if (typeof details !== "object" || details === null) return [];
  const record = details as Record<string, unknown>;
  if (record.kind !== "review" || !Array.isArray(record.items)) return [];
  return record.items.map((item): SpanEvent => {
    const finding = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const attributes = [attr("message", String(finding.message ?? ""))];
    if (typeof finding.file === "string") attributes.push(attr("file", finding.file));
    return { timeUnixNano, name: "review.finding", attributes };
  });
}

/**
 * Built-in reporter that emits OTLP/HTTP-JSON traces + metrics per run.
 * Buffers each run's story completions as span events and flushes one traces
 * POST + one metrics POST at run end. Fire-and-forget.
 *
 * @param cfg  - resolved OTel reporter config (closed over by the reporter)
 * @param deps - injectable fetch deps (tests only)
 */
export function createOtelReporterPlugin(cfg: OtelReporterConfig, deps?: PostJsonDeps): NaxPlugin {
  const states = new Map<string, RunState>();
  const base = cfg.endpoint?.replace(/\/$/, "");
  let tornDown = false;

  const exportHeartbeat = async (snapshot: HeartbeatSnapshot): Promise<void> => {
    if (!base) return;
    const { resolved, missing } = interpolateHeaders(cfg.headers);
    if (missing.length > 0) return;
    const metrics = buildHeartbeatMetricsPayload({
      serviceName: cfg.serviceName,
      timeUnixNano: msToUnixNano(Date.now()),
      snapshot,
    });
    await postJson(`${base}/v1/metrics`, metrics, { headers: resolved, timeoutMs: cfg.timeoutMs, stage: STAGE, deps });
  };

  const flush = async (st: RunState, endMs: number, e: RunEndEvent): Promise<void> => {
    if (!base) return;
    const { resolved, missing } = interpolateHeaders(cfg.headers);
    if (missing.length > 0) {
      getSafeLogger()?.warn(STAGE, "Skipping OTLP export — unresolved env vars", { missing });
      return;
    }
    const startUnixNano = msToUnixNano(st.startMs);
    const endUnixNano = msToUnixNano(endMs);
    const traces = buildTracesPayload({
      serviceName: cfg.serviceName,
      traceId: st.traceId,
      spanId: st.spanId,
      parentSpanId: st.parentSpanId,
      startUnixNano,
      endUnixNano,
      feature: st.feature,
      runId: e.runId,
      storySummary: e.storySummary,
      totalCost: e.totalCost,
      events: st.events,
      extraSpans: st.phaseSpans,
    });
    const metrics = buildMetricsPayload({
      serviceName: cfg.serviceName,
      runId: e.runId,
      timeUnixNano: endUnixNano,
      storySummary: e.storySummary,
      totalCost: e.totalCost,
      totalDurationMs: e.totalDurationMs,
    });
    const opts = { headers: resolved, timeoutMs: cfg.timeoutMs, stage: STAGE, deps };
    await postJson(`${base}/v1/traces`, traces, opts);
    await postJson(`${base}/v1/metrics`, metrics, opts);
  };

  const reporter: IReporter = {
    name: STAGE,
    async onRunStart(event) {
      const identity = rootSpanIdentity();
      const runId = event.runId;
      const state: RunState = {
        ...identity,
        startMs: Date.parse(event.startTime),
        feature: event.feature,
        project: event.project ?? "",
        events: [],
        spanTree: createSpanTree(identity.traceId, identity.spanId),
        phaseSpans: [],
        costUsd: 0,
        heartbeat: startHeartbeat({
          intervalMs: cfg.heartbeatIntervalMs ?? 0,
          getSnapshot: () => heartbeatSnapshotOf(runId, state),
          onTick: (snapshot) => exportHeartbeat(snapshot),
        }),
      };
      states.set(runId, state);
    },
    async onStoryComplete(event) {
      const st = states.get(event.runId);
      if (!st) return;
      st.events.push({
        timeUnixNano: msToUnixNano(st.startMs + event.runElapsedMs),
        name: "story.complete",
        attributes: [
          attr("storyId", event.storyId),
          attr("status", event.status),
          attr("cost", event.cost),
          attr("tier", event.tier),
          attr("testStrategy", event.testStrategy),
        ],
      });
    },
    async onPhaseComplete(event) {
      const st = states.get(event.runId);
      if (!st) return;
      st.costUsd += event.costUsd;
      st.lastPhase = {
        phase: event.phase,
        storyId: event.storyId ?? "",
        tier: event.tier ?? "",
        testStrategy: event.testStrategy ?? "",
        atMs: Date.now(),
      };
      const endMs = Date.now();
      const endUnixNano = msToUnixNano(endMs);
      const span = st.spanTree.buildPhaseSpan({
        event,
        traceId: st.traceId,
        startUnixNano: msToUnixNano(endMs - event.durationMs),
        endUnixNano,
      });
      const events = reviewSpanEvents(event.details, endUnixNano, cfg.detail === "verbose");
      if (events.length > 0) span.events = events;
      st.phaseSpans.push(span);
    },
    async onRunEnd(event) {
      // Normal path: state exists. Early-abort path: synthesize a best-effort
      // span whose start is back-computed from the reported duration.
      const existing = states.get(event.runId);
      existing?.heartbeat.stop();
      const startMs = existing?.startMs ?? Date.now() - event.totalDurationMs;
      const st: RunState = existing ?? buildOrphanState(startMs);
      states.delete(event.runId);
      await flush(st, startMs + event.totalDurationMs, event);
    },
  };

  return {
    name: STAGE,
    version: "1.0.0",
    provides: ["reporter"],
    async teardown() {
      // Idempotent backstop: flushes any run that ended without onRunEnd
      // (abnormal exit). A second call, or a call after onRunEnd already
      // flushed and deleted the run's state, is a no-op.
      if (tornDown) return;
      tornDown = true;
      const entries = [...states.entries()];
      states.clear();
      for (const [runId, st] of entries) {
        st.heartbeat.stop();
        const endMs = Date.now();
        await flush(st, endMs, {
          runId,
          totalDurationMs: endMs - st.startMs,
          totalCost: st.costUsd,
          storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
        });
      }
    },
    extensions: { reporter },
  };
}
