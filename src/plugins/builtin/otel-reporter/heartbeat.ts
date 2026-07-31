import { getSafeLogger } from "@/logger";
import { type KeyValue, attr, buildResourceAttributes } from "./otlp";

const STAGE = "otel-reporter-heartbeat";

/** Attributes carried by every heartbeat gauge (US-008). */
export interface HeartbeatAttributes {
  runId: string;
  feature: string;
  project: string;
  storyId: string;
  phase: string;
  tier: string;
  testStrategy: string;
}

/** Point-in-time state a heartbeat tick exports as `nax.run.*` gauges. */
export interface HeartbeatSnapshot {
  attributes: HeartbeatAttributes;
  /** Elapsed ms since the most recently completed phase event. */
  phaseElapsedMs: number;
  /** Run's accumulated cost in USD. */
  costUsd: number;
}

export interface HeartbeatOptions {
  /** Cadence in ms. `0` must disable the heartbeat entirely. */
  intervalMs: number;
  /** Called on each tick to build the snapshot to export. */
  getSnapshot: () => HeartbeatSnapshot;
  /** Invoked once per elapsed interval with the current snapshot. */
  onTick: (snapshot: HeartbeatSnapshot) => void | Promise<void>;
}

export interface Heartbeat {
  /** Stops future ticks. Idempotent. */
  stop(): void;
}

/**
 * Starts a repeating heartbeat timer. `intervalMs <= 0` disables it entirely
 * (no timer armed). Uses a re-armed `setTimeout` rather than `setInterval` so
 * `stop()` can cancel the exact pending handle via `clearTimeout` — the
 * cancellable-handle exception documented in forbidden-patterns.md.
 */
export function startHeartbeat(opts: HeartbeatOptions): Heartbeat {
  const { intervalMs, getSnapshot, onTick } = opts;
  if (intervalMs <= 0) return { stop() {} };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const armTimer = (): void => {
    timer = setTimeout(() => {
      // Never let a telemetry tick escalate into a fatal unhandled
      // rejection/exception (src/execution/crash-signals.ts aborts the run
      // on either) — mirrors batch-queue.ts's own defensive try/catch.
      try {
        Promise.resolve(onTick(getSnapshot())).catch((err) =>
          getSafeLogger()?.warn(STAGE, "Heartbeat tick failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } catch (err) {
        getSafeLogger()?.warn(STAGE, "Heartbeat tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!stopped) armTimer();
    }, intervalMs);
  };
  armTimer();

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function heartbeatAttributes(a: HeartbeatAttributes): KeyValue[] {
  return [
    attr("run_id", a.runId),
    attr("feature", a.feature),
    attr("project", a.project),
    attr("story_id", a.storyId),
    attr("phase", a.phase),
    attr("tier", a.tier),
    attr("test_strategy", a.testStrategy),
  ];
}

export interface HeartbeatMetricsInput {
  serviceName: string;
  timeUnixNano: string;
  snapshot: HeartbeatSnapshot;
}

/** Build the OTLP/HTTP-JSON gauge payload for one heartbeat tick. */
export function buildHeartbeatMetricsPayload(p: HeartbeatMetricsInput): object {
  const attributes = heartbeatAttributes(p.snapshot.attributes);
  const gauge = (name: string, value: number) => ({
    name,
    gauge: { dataPoints: [{ asDouble: value, timeUnixNano: p.timeUnixNano, attributes }] },
  });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: buildResourceAttributes({
            serviceName: p.serviceName,
            runId: p.snapshot.attributes.runId,
          }),
        },
        scopeMetrics: [
          {
            scope: { name: "nax" },
            metrics: [
              gauge("nax.run.active", 1),
              gauge("nax.run.phase_elapsed_ms", p.snapshot.phaseElapsedMs),
              gauge("nax.run.cost_usd", p.snapshot.costUsd),
            ],
          },
        ],
      },
    ],
  };
}
