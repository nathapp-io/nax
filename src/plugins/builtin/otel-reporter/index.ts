import type { OtelReporterConfig } from "@/config/schemas-reporters";
import type { LogEntry, LogSink } from "@/logger";
import { addSink, getSafeLogger } from "@/logger";
import type { EscalationEvent, IReporter, NaxPlugin, RunEndEvent } from "@/plugins/types";
import { gitWithTimeout } from "@/utils/git";
import { interpolateHeaders, type PostJsonDeps, postJson } from "../reporter-shared";
import { type BatchQueue, createBatchQueue } from "./batch-queue";
import { buildHeartbeatMetricsPayload, type Heartbeat, type HeartbeatSnapshot, startHeartbeat } from "./heartbeat";
import { newSpanId, newTraceId } from "./ids";
import { buildLogsPayload } from "./logs";
import {
  attr,
  buildMetricsPayload,
  buildResourceAttributes,
  buildTracesPayload,
  type KeyValue,
  msToUnixNano,
  type SpanEvent,
} from "./otlp";
import {
  createPhaseMetricsAggregator,
  createSpanTree,
  type PhaseMetricsAggregator,
  type Span,
  type SpanTree,
} from "./span-tree";
import { parseTraceparent } from "./traceparent";

const STAGE = "otel-reporter";
const REENTRY_STAGE = "otel-batch-queue";
/** Stages whose own log entries must never be re-enqueued into the logs sink — an export
 * failure logged from either the reporter itself or the batch queue would otherwise
 * amplify into a recursive cascade. */
const REENTRY_STAGES = new Set([STAGE, REENTRY_STAGE]);
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 2_048;

const LOG_PRIORITY: Record<string, number> = {
  silent: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

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
  gitBranch?: string;
  gitSha?: string;
  events: SpanEvent[];
  spanTree: SpanTree;
  spanQueue: BatchQueue<Span>;
  metrics: PhaseMetricsAggregator;
  /** Earliest phase start / latest phase end per story, for the `nax.story` span (US-007). */
  storyBounds: Map<string, { startMs: number; endMs: number }>;
  costUsd: number;
  lastPhase?: LastPhase;
  heartbeat: Heartbeat;
  logsQueue?: BatchQueue<LogEntry>;
  logUnsubscribe?: () => void;
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

interface ReporterDeps extends PostJsonDeps {
  addSink?: (sink: LogSink) => () => void;
}

/**
 * Built-in reporter that emits OTLP/HTTP-JSON traces + metrics per run.
 * Buffers each run's story completions as span events and flushes one traces
 * POST + one metrics POST at run end. Fire-and-forget.
 *
 * When `cfg.logs.enabled` is true, also registers a logger sink to export
 * redacted log entries as OTLP LogRecords through a dedicated queue.
 *
 * @param cfg     - resolved OTel reporter config (closed over by the reporter)
 * @param deps    - injectable deps (tests only)
 * @param workdir - target repository root, used for best-effort git branch/sha resolution
 */
export function createOtelReporterPlugin(cfg: OtelReporterConfig, deps?: ReporterDeps, workdir?: string): NaxPlugin {
  const states = new Map<string, RunState>();
  const base = cfg.endpoint?.replace(/\/$/, "");
  let tornDown = false;

  /** Incremental export for phase spans (US-006) — a standalone traces POST per batch, no root span. */
  const makeSendSpanBatch =
    (resourceAttrs: KeyValue[]): ((batch: Span[]) => Promise<boolean>) =>
    async (batch: Span[]): Promise<boolean> => {
      if (!base || batch.length === 0) return true;
      const { resolved, missing } = interpolateHeaders(cfg.headers);
      if (missing.length > 0) {
        getSafeLogger()?.warn(STAGE, "Skipping OTLP export — unresolved env vars", { missing });
        return true; // not a transient failure — don't burn a batch-queue retry
      }
      const payload = {
        resourceSpans: [
          {
            resource: { attributes: resourceAttrs },
            scopeSpans: [{ scope: { name: "nax" }, spans: batch }],
          },
        ],
      };
      return postJson(`${base}/v1/traces`, payload, {
        headers: resolved,
        timeoutMs: cfg.timeoutMs,
        stage: STAGE,
        deps,
      });
    };

  const makeSpanQueue = (resourceAttrs: KeyValue[]): BatchQueue<Span> =>
    createBatchQueue<Span>({
      maxBatchSize: cfg.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      flushIntervalMs: cfg.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxQueueSize: cfg.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      send: makeSendSpanBatch(resourceAttrs),
    });

  const makeSendLogsBatch =
    (resource: {
      serviceName: string;
      runId: string;
      feature: string;
      project: string;
      gitBranch?: string;
      gitSha?: string;
    }): ((batch: LogEntry[]) => Promise<boolean>) =>
    async (batch: LogEntry[]): Promise<boolean> => {
      if (!base || batch.length === 0) return true;
      const { resolved, missing } = interpolateHeaders(cfg.headers);
      if (missing.length > 0) {
        getSafeLogger()?.warn(STAGE, "Skipping OTLP export — unresolved env vars", { missing });
        return true; // not a transient failure — don't burn a batch-queue retry
      }
      const payload = buildLogsPayload(batch, {
        serviceName: resource.serviceName,
        runId: resource.runId,
        feature: resource.feature,
        project: resource.project,
        git: { branch: resource.gitBranch, sha: resource.gitSha },
      });
      return postJson(`${base}/v1/logs`, payload, {
        headers: resolved,
        timeoutMs: cfg.timeoutMs,
        stage: STAGE,
        deps,
      });
    };

  const makeLogsQueue = (resource: {
    serviceName: string;
    runId: string;
    feature: string;
    project: string;
    gitBranch?: string;
    gitSha?: string;
  }): BatchQueue<LogEntry> =>
    createBatchQueue<LogEntry>({
      maxBatchSize: cfg.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      flushIntervalMs: cfg.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxQueueSize: cfg.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      send: makeSendLogsBatch(resource),
    });

  /** Best-effort run state for an `onRunEnd` with no preceding `onRunStart` (US-008 AC16). */
  const buildOrphanState = (startMs: number): RunState => {
    const identity = rootSpanIdentity();
    const orphanAttrs = buildResourceAttributes({ serviceName: cfg.serviceName, runId: "orphan" });
    return {
      ...identity,
      startMs,
      feature: "",
      project: "",
      events: [],
      spanTree: createSpanTree(identity.traceId, identity.spanId),
      spanQueue: makeSpanQueue(orphanAttrs),
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
      project: st.project,
      gitBranch: st.gitBranch,
      gitSha: st.gitSha,
      runId: e.runId,
      storySummary: e.storySummary,
      totalCost: e.totalCost,
      events: st.events,
    });
    const metrics = buildMetricsPayload({
      serviceName: cfg.serviceName,
      runId: e.runId,
      timeUnixNano: endUnixNano,
      feature: st.feature,
      project: st.project,
      gitBranch: st.gitBranch,
      gitSha: st.gitSha,
      storySummary: e.storySummary,
      totalCost: e.totalCost,
      totalDurationMs: e.totalDurationMs,
    }) as { resourceMetrics: [{ scopeMetrics: [{ metrics: object[] }] }] };
    // US-007: merge the run's accumulated phase histograms + counters into the
    // same metrics POST (SEAM-5) rather than issuing a third export request.
    const aggMetrics = st.metrics.buildMetricsPayload({
      serviceName: cfg.serviceName,
      runId: e.runId,
      timeUnixNano: endUnixNano,
      feature: st.feature,
      project: st.project,
      gitBranch: st.gitBranch,
      gitSha: st.gitSha,
    }) as {
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

      let gitBranch: string | undefined;
      let gitSha: string | undefined;
      if (base && workdir) {
        const [branchResult, shaResult] = await Promise.all([
          gitWithTimeout(["rev-parse", "--abbrev-ref", "HEAD"], workdir).catch(() => null),
          gitWithTimeout(["rev-parse", "HEAD"], workdir).catch(() => null),
        ]);
        if (branchResult?.exitCode === 0) {
          const branch = branchResult.stdout.trim();
          if (branch && branch !== "HEAD") gitBranch = branch;
        }
        if (shaResult?.exitCode === 0) {
          const sha = shaResult.stdout.trim();
          if (sha) gitSha = sha;
        }
      }

      const resourceAttrs = buildResourceAttributes({
        serviceName: cfg.serviceName,
        runId,
        feature: event.feature,
        project: event.project,
        git: { branch: gitBranch, sha: gitSha },
      });

      const state: RunState = {
        ...identity,
        startMs: Date.parse(event.startTime),
        feature: event.feature,
        project: event.project ?? "",
        gitBranch,
        gitSha,
        events: [],
        spanTree: createSpanTree(identity.traceId, identity.spanId),
        spanQueue: makeSpanQueue(resourceAttrs),
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

      if (cfg.logs?.enabled) {
        const logsQueue = makeLogsQueue({
          serviceName: cfg.serviceName,
          runId,
          feature: event.feature,
          project: event.project ?? "",
          gitBranch,
          gitSha,
        });
        const floorKey = cfg.logs.level;
        const sank: LogSink = (entry) => {
          // Re-entrancy guard: entries logged by the exporter itself must not
          // be re-enqueued, otherwise an export failure that logs a warning
          // would amplify into a recursive cascade.
          if (REENTRY_STAGES.has(entry.stage)) return;
          if (LOG_PRIORITY[entry.level] > LOG_PRIORITY[floorKey]) return;
          logsQueue.enqueue(entry);
        };
        const addSinkFn = deps?.addSink ?? addSink;
        state.logsQueue = logsQueue;
        state.logUnsubscribe = addSinkFn(sank);
      }
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
      // Flush any logs still queued, then unsubscribe the sink so subsequent
      // log calls are not silently dropped (the queue is tearing down).
      if (st.logsQueue) {
        await st.logsQueue.flushNow();
        st.logsQueue.teardown();
        st.logUnsubscribe?.();
      }
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
        if (st.logsQueue) {
          await st.logsQueue.flushNow();
          st.logsQueue.teardown();
          st.logUnsubscribe?.();
        }
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
