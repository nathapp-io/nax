import { getSafeLogger } from "@/logger";
import { attr, buildResourceAttributes, type KeyValue, type OtlpMetricsPayload } from "./otlp";

const STAGE = "otel-reporter-heartbeat";

/**
 * Injectable timer pair — allows tests to drive the heartbeat off a virtual
 * clock instead of sleeping for real, which is both faster and removes the
 * scheduling races that loose "at least one tick fired" bounds paper over.
 *
 * @internal
 */
export const _heartbeatDeps = {
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)) as (id: unknown) => void,
};

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
  let timer: unknown;

  const armTimer = (): void => {
    timer = _heartbeatDeps.setTimeout(() => {
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
      if (timer !== undefined) _heartbeatDeps.clearTimeout(timer);
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
export function buildHeartbeatMetricsPayload(p: HeartbeatMetricsInput): OtlpMetricsPayload {
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
