import type { OtelReporterConfig } from "@/config/schemas-reporters";
import { getSafeLogger } from "@/logger";
import type { IReporter, NaxPlugin, RunEndEvent } from "@/plugins/types";
import { type PostJsonDeps, interpolateHeaders, postJson } from "../reporter-shared";
import { newSpanId, newTraceId } from "./ids";
import { type SpanEvent, attr, buildMetricsPayload, buildTracesPayload, msToUnixNano } from "./otlp";
import { parseTraceparent } from "./traceparent";

const STAGE = "otel-reporter";

interface RunState {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  feature: string;
  events: SpanEvent[];
}

/** Root span identity: adopts the W3C TRACEPARENT env var when valid, else starts a new root trace. */
function rootSpanIdentity(): { traceId: string; spanId: string; parentSpanId?: string } {
  const adopted = parseTraceparent(process.env.TRACEPARENT);
  if (!adopted) return { traceId: newTraceId(), spanId: newSpanId() };
  return { traceId: adopted.traceId, spanId: newSpanId(), parentSpanId: adopted.spanId };
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
    });
    const opts = { headers: resolved, timeoutMs: cfg.timeoutMs, stage: STAGE, deps };
    await postJson(`${base}/v1/traces`, traces, opts);
    await postJson(`${base}/v1/metrics`, metrics, opts);
  };

  const reporter: IReporter = {
    name: STAGE,
    async onRunStart(event) {
      states.set(event.runId, {
        ...rootSpanIdentity(),
        startMs: Date.parse(event.startTime),
        feature: event.feature,
        events: [],
      });
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
    async onRunEnd(event) {
      // Normal path: state exists. Early-abort path: synthesize a best-effort
      // span whose start is back-computed from the reported duration.
      const existing = states.get(event.runId);
      const startMs = existing?.startMs ?? Date.now() - event.totalDurationMs;
      const st: RunState = existing ?? {
        ...rootSpanIdentity(),
        startMs,
        feature: "",
        events: [],
      };
      states.delete(event.runId);
      await flush(st, startMs + event.totalDurationMs, event);
    },
  };

  return {
    name: STAGE,
    version: "1.0.0",
    provides: ["reporter"],
    extensions: { reporter },
  };
}
