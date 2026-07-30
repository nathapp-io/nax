import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { getSafeLogger } from "@/logger";
import type { EscalationEvent, IReporter, NaxPlugin, RunEndEvent } from "@/plugins/types";
import { type PostJsonDeps, interpolateHeaders, postJson } from "../reporter-shared";
import { type BatchQueue, createBatchQueue } from "./batch-queue";
import { type Heartbeat, type HeartbeatSnapshot, buildHeartbeatMetricsPayload, startHeartbeat } from "./heartbeat";
import { newSpanId, newTraceId } from "./ids";
import { type SpanEvent, attr, buildMetricsPayload, buildTracesPayload, msToUnixNano } from "./otlp";
import {
  type PhaseMetricsAggregator,
  type Span,
  type SpanTree,
  createPhaseMetricsAggregator,
  createSpanTree,
} from "./span-tree";
import { parseTraceparent } from "./traceparent";

const STAGE = "otel-reporter";
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 2_048;

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
  spanQueue: BatchQueue<Span>;
  metrics: PhaseMetricsAggregator;
  /** Earliest phase start / latest phase end per story, for the `nax.story` span (US-007). */
  storyBounds: Map<string, { startMs: number; endMs: number }>;
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
 * Feeds `nax.review.findings` / `nax.fix.iterations` from a phase's `details`
 * payload (US-007). No-op for phases whose `details` isn't a review/fix arm.
 */
function recordDetailMetrics(metrics: PhaseMetricsAggregator, phase: string, details: unknown): void {
  if (typeof details !== "object" || details === null) return;
  const record = details as Record<string, unknown>;
  if (record.kind === "review" && typeof record.bySeverity === "object" && record.bySeverity !== null) {
    for (const [severity, count] of Object.entries(record.bySeverity as Record<string, number>)) {
      if (count > 0) metrics.recordReviewFindings(phase, severity, count);
    }
  } else if (record.kind === "fix" && typeof record.strategy === "string") {
    metrics.recordFixIterations(phase, record.strategy, 1);
  }
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

  /** Incremental export for phase spans (US-006) — a standalone traces POST per batch, no root span. */
  const sendSpanBatch = async (batch: Span[]): Promise<boolean> => {
    if (!base || batch.length === 0) return true;
    const { resolved, missing } = interpolateHeaders(cfg.headers);
    if (missing.length > 0) {
      getSafeLogger()?.warn(STAGE, "Skipping OTLP export — unresolved env vars", { missing });
      return true; // not a transient failure — don't burn a batch-queue retry
    }
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [attr("service.name", cfg.serviceName)] },
          scopeSpans: [{ scope: { name: "nax" }, spans: batch }],
        },
      ],
    };
    return postJson(`${base}/v1/traces`, payload, { headers: resolved, timeoutMs: cfg.timeoutMs, stage: STAGE, deps });
  };

  const makeSpanQueue = (): BatchQueue<Span> =>
    createBatchQueue<Span>({
      maxBatchSize: cfg.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      flushIntervalMs: cfg.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxQueueSize: cfg.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      send: sendSpanBatch,
    });

  /** Best-effort run state for an `onRunEnd` with no preceding `onRunStart` (US-008 AC16). */
  const buildOrphanState = (startMs: number): RunState => {
    const identity = rootSpanIdentity();
    return {
      ...identity,
      startMs,
      feature: "",
      project: "",
      events: [],
      spanTree: createSpanTree(identity.traceId, identity.spanId),
      spanQueue: makeSpanQueue(),
      metrics: createPhaseMetricsAggregator(),
      storyBounds: new Map(),
      costUsd: 0,
      heartbeat: { stop() {} },
    };
  };

  const exportHeartbeat = async (snapshot: HeartbeatSnapshot): Promise<void> => {
    if (!base) return;
    const { resolved, missing } = interpolateHeaders(cfg.headers);
    if (missing.length > 0) {
      getSafeLogger()?.warn(STAGE, "Skipping OTLP export — unresolved env vars", { missing });
      return;
    }
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
    });
    const metrics = buildMetricsPayload({
      serviceName: cfg.serviceName,
      runId: e.runId,
      timeUnixNano: endUnixNano,
      storySummary: e.storySummary,
      totalCost: e.totalCost,
      totalDurationMs: e.totalDurationMs,
    }) as { resourceMetrics: [{ scopeMetrics: [{ metrics: object[] }] }] };
    // US-007: merge the run's accumulated phase histograms + counters into the
    // same metrics POST (SEAM-5) rather than issuing a third export request.
    const aggMetrics = st.metrics.buildMetricsPayload(cfg.serviceName, e.runId, endUnixNano) as {
      resourceMetrics: [{ scopeMetrics: [{ metrics: object[] }] }];
    };
    metrics.resourceMetrics[0].scopeMetrics[0].metrics.push(...aggMetrics.resourceMetrics[0].scopeMetrics[0].metrics);
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
        spanQueue: makeSpanQueue(),
        metrics: createPhaseMetricsAggregator(),
        storyBounds: new Map(),
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
      // Build the `nax.story` span once the story's phase bounds are known —
      // spans the earliest phase start through the latest phase end.
      const bounds = st.storyBounds.get(event.storyId);
      if (bounds) {
        st.spanQueue.enqueue(
          st.spanTree.buildStorySpan(event.storyId, msToUnixNano(bounds.startMs), msToUnixNano(bounds.endMs)),
        );
        st.storyBounds.delete(event.storyId);
      }
    },
    async onPhaseComplete(event) {
      const st = states.get(event.runId);
      if (!st) return;
      st.costUsd += event.costUsd ?? 0;
      st.lastPhase = {
        phase: event.phase,
        storyId: event.storyId ?? "",
        tier: event.tier ?? "",
        testStrategy: event.testStrategy ?? "",
        atMs: Date.now(),
      };
      const endMs = Date.now();
      const startMs = endMs - event.durationMs;
      const endUnixNano = msToUnixNano(endMs);
      const span = st.spanTree.buildPhaseSpan({
        event,
        traceId: st.traceId,
        startUnixNano: msToUnixNano(startMs),
        endUnixNano,
      });
      const events = reviewSpanEvents(event.details, endUnixNano, cfg.detail === "verbose");
      if (events.length > 0) span.events = events;
      st.spanQueue.enqueue(span);
      st.metrics.recordPhase(event);
      recordDetailMetrics(st.metrics, event.phase, event.details);
      if (event.scope === "story" && event.storyId !== undefined) {
        const bounds = st.storyBounds.get(event.storyId);
        st.storyBounds.set(event.storyId, {
          startMs: bounds ? Math.min(bounds.startMs, startMs) : startMs,
          endMs: bounds ? Math.max(bounds.endMs, endMs) : endMs,
        });
      }
    },
    async onEscalation(event: EscalationEvent) {
      const st = states.get(event.runId);
      if (!st) return;
      st.metrics.recordEscalation(event.toTier, 1);
    },
    async onRunEnd(event) {
      // Normal path: state exists. Early-abort path: synthesize a best-effort
      // span whose start is back-computed from the reported duration.
      const existing = states.get(event.runId);
      existing?.heartbeat.stop();
      const startMs = existing?.startMs ?? Date.now() - event.totalDurationMs;
      const st: RunState = existing ?? buildOrphanState(startMs);
      states.delete(event.runId);
      // SEAM-4: flush any spans still queued before the run-level export, on
      // both the normal (bus) and abnormal-exit (direct-call) onRunEnd paths.
      await st.spanQueue.flushNow();
      st.spanQueue.teardown();
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
        await st.spanQueue.flushNow();
        st.spanQueue.teardown();
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
