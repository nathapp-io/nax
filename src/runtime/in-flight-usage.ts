// In-flight native usage tracker (US-003).
//
// A native turn still running at shutdown has no finished dispatch row, even
// though its `agent.usage_update` beats report spend. This module accumulates
// the per-stream-`callId` deltas and maps whatever is still unrecorded onto a
// schema-v7 partial `CostEvent` (see `toPartialCostEvent`).
import type { IAgentStreamEventBus } from "./agent-stream-events";
import type { CostEvent } from "./cost-aggregator";
import type { IDispatchEventBus } from "./dispatch-events";

/** One stream's accumulated, not-yet-recorded spend. */
export interface InFlightResidual {
  readonly streamCallId: string;
  readonly agentName: string;
  /** From `agent.call_started`; `"unknown"` when none was seen. */
  readonly model: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: string;
  readonly scopeId?: string;
  readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  readonly costUsd: number;
  readonly roundTrips: number;
}

export interface InFlightUsageTracker {
  residuals(): readonly InFlightResidual[];
}

/**
 * Subscribes to both buses; the returned `off` detaches both.
 *
 * STUB — the implementer replaces the body; the accumulator rules are in the
 * story's Approach section.
 */
export function attachInFlightUsageTracker(
  _streamBus: IAgentStreamEventBus,
  _dispatchEvents: IDispatchEventBus,
): { tracker: InFlightUsageTracker; off: () => void } {
  return { tracker: { residuals: () => [] }, off: () => {} };
}

/** Maps one residual to a `CostEvent` with `partial: true`. STUB. */
export function toPartialCostEvent(residual: InFlightResidual, runId: string, _projectKey?: string): CostEvent {
  return {
    ts: 0,
    runId,
    agentName: residual.agentName,
    model: residual.model,
    estimatedCostUsd: 0,
    exactCostUsd: 0,
    costUsd: 0,
    confidence: "estimated",
    durationMs: 0,
  };
}
