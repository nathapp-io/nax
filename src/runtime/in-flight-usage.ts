// In-flight native usage tracker (US-003).
//
// A native turn still running at shutdown has no finished dispatch row, even
// though its `agent.usage_update` beats report spend. This module accumulates
// the per-stream-`callId` deltas and maps whatever is still unrecorded onto a
// schema-v7 partial `CostEvent` (see `toPartialCostEvent`).
import type {
  AgentCallEndedEvent,
  AgentCallStartedEvent,
  AgentStreamEvent,
  AgentUsageUpdateEvent,
  IAgentStreamEventBus,
} from "./agent-stream-events";
import type { CostEvent } from "./cost-aggregator";
import type { DispatchErrorEvent, DispatchEvent, IDispatchEventBus } from "./dispatch-events";
import { COST_ROW_SCHEMA_VERSION } from "./middleware";
import { deriveSessionRole } from "./usage-auditor";

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
 * The mutable accumulator behind one stream `callId`. `endedStatus` is set when
 * a `call_ended` reported `"error"` or `"cancelled"` — the turn did not resolve,
 * so its spend may still be unrecorded. `endedSeq` orders those ends for
 * dispatch-error reconciliation (the most recent one wins).
 */
interface StreamEntry {
  streamCallId: string;
  agentName: string;
  model: string;
  sessionName: string;
  storyId?: string;
  stage?: string;
  scopeId?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  roundTrips: number;
  endedStatus?: "error" | "cancelled";
  endedSeq?: number;
}

function hasSpend(entry: StreamEntry): boolean {
  const { input, output, cacheRead, cacheWrite } = entry.tokens;
  return entry.costUsd > 0 || input + output + cacheRead + cacheWrite > 0;
}

/**
 * Subscribes to both buses; the returned `off` detaches both.
 *
 * Applies the story's reconciliation rules in order per stream `callId`:
 * accumulate round-trip deltas, resolve on a successful/`timeout` end, retain an
 * `error`/`cancelled` end as "ended-unrecorded", then clear an entry when its
 * spend is shown to have landed on a dispatch row (a session-turn event for a
 * cancelled turn, or a dispatch-error event for an errored one).
 */
export function attachInFlightUsageTracker(
  streamBus: IAgentStreamEventBus,
  dispatchEvents: IDispatchEventBus,
): { tracker: InFlightUsageTracker; off: () => void } {
  const entries = new Map<string, StreamEntry>();
  const latestEndedBySession = new Map<string, string>();
  let endedSeq = 0;

  const entryFor = (event: AgentStreamEvent): StreamEntry => {
    let entry = entries.get(event.callId);
    if (entry === undefined) {
      entry = {
        streamCallId: event.callId,
        agentName: event.agentName,
        model: "unknown",
        sessionName: event.sessionName,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        roundTrips: 0,
      };
      entries.set(event.callId, entry);
    }
    entry.agentName = event.agentName;
    entry.sessionName = event.sessionName;
    // Native stream events carry no storyId/stage on this path, so record them
    // only when an event actually supplies them.
    if (event.storyId !== undefined) entry.storyId = event.storyId;
    if (event.stage !== undefined) entry.stage = event.stage;
    if (event.scopeId !== undefined) entry.scopeId = event.scopeId;
    return entry;
  };

  const onUsageUpdate = (event: AgentUsageUpdateEvent): void => {
    if (event.cadence !== "round-trip") return;
    const entry = entryFor(event);
    entry.tokens.input += event.inputTokens ?? 0;
    entry.tokens.output += event.outputTokens ?? 0;
    entry.tokens.cacheRead += event.cacheRead ?? 0;
    entry.tokens.cacheWrite += event.cacheWrite ?? 0;
    entry.costUsd += event.costUsd ?? 0;
    // Compaction and retry beats carry no `roundTrip`, so they must not inflate
    // the count — only a genuine round-trip boundary increments it.
    if (event.roundTrip !== undefined) entry.roundTrips += 1;
  };

  const onCallStarted = (event: AgentCallStartedEvent): void => {
    const entry = entryFor(event);
    entry.model = event.model === "" ? "unknown" : event.model;
  };

  /**
   * Drop an entry and forget it as its session's most-recent end. Without the
   * forget, a reconciled callId lingers in `latestEndedBySession` and every
   * later session-turn for that session does a lookup guaranteed to miss.
   */
  const forget = (callId: string): void => {
    entries.delete(callId);
    for (const [sessionName, remembered] of latestEndedBySession) {
      if (remembered === callId) latestEndedBySession.delete(sessionName);
    }
  };

  const onCallEnded = (event: AgentCallEndedEvent): void => {
    // Rule 5: remember the stream that most recently ended in this session,
    // whatever its status — a session-turn event consults this to find the
    // watchdog-cancelled turn whose spend has now landed on the session row.
    latestEndedBySession.set(event.sessionName, event.callId);
    if (event.status === "success" || event.status === "timeout") {
      // The turn resolved, so its dispatch event records the spend.
      forget(event.callId);
      return;
    }
    // Rule 4 marks "the entry" ended-unrecorded — it does not create one. A
    // turn that ended with no prior beat/start carries no spend to track, so
    // materialising an entry would leak an invisible map row for the life of
    // the tracker (nothing else deletes a scope-less zero-spend entry).
    const existing = entries.get(event.callId);
    if (existing === undefined) return;
    // Refresh attribution even though the entry already exists: a `scopeId`
    // (or storyId/stage) carried only on `call_ended` must land here, or
    // rule-6 reconciliation can never match this stream.
    const entry = entryFor(event);
    entry.endedStatus = event.status;
    endedSeq += 1;
    entry.endedSeq = endedSeq;
  };

  const onDispatch = (event: DispatchEvent): void => {
    if (event.kind !== "session-turn") return;
    const callId = latestEndedBySession.get(event.sessionName);
    if (callId === undefined) return;
    const entry = entries.get(callId);
    // Only a watchdog-cancelled turn is cleared: its spend is on the session
    // row. A successful turn is already gone, and an errored entry stays.
    if (entry !== undefined && entry.endedStatus === "cancelled") forget(callId);
  };

  const matchesScope = (entry: StreamEntry, event: DispatchErrorEvent): boolean => {
    if (entry.scopeId === undefined) return false;
    return entry.scopeId === event.scopeId || entry.scopeId === event.callId;
  };

  const onDispatchError = (event: DispatchErrorEvent): void => {
    const hasUsage = event.tokenUsage !== undefined;
    const costUsd = event.exactCostUsd ?? event.estimatedCostUsd ?? 0;
    // Rule 6: only an error row that actually recorded spend may clear an
    // entry. `NaN`/`Infinity` are malformed reports, not recorded spend — the
    // finite-positive test rejects them (a bare `<= 0` negation let `NaN`
    // through, since `NaN <= 0` is false).
    if (!hasUsage && !(Number.isFinite(costUsd) && costUsd > 0)) return;

    let target: StreamEntry | undefined;
    for (const entry of entries.values()) {
      if (entry.endedStatus === undefined || !matchesScope(entry, event)) continue;
      if (target === undefined || (entry.endedSeq ?? 0) > (target.endedSeq ?? 0)) target = entry;
    }
    if (target !== undefined) forget(target.streamCallId);
  };

  const onStream = (event: AgentStreamEvent): void => {
    if (event.kind === "agent.usage_update") onUsageUpdate(event);
    else if (event.kind === "agent.call_started") onCallStarted(event);
    else if (event.kind === "agent.call_ended") onCallEnded(event);
  };

  const residuals = (): readonly InFlightResidual[] => {
    const out: InFlightResidual[] = [];
    for (const entry of entries.values()) {
      if (!hasSpend(entry)) continue;
      out.push({
        streamCallId: entry.streamCallId,
        agentName: entry.agentName,
        model: entry.model,
        sessionName: entry.sessionName,
        ...(entry.storyId !== undefined ? { storyId: entry.storyId } : {}),
        ...(entry.stage !== undefined ? { stage: entry.stage } : {}),
        ...(entry.scopeId !== undefined ? { scopeId: entry.scopeId } : {}),
        tokens: { ...entry.tokens },
        costUsd: entry.costUsd,
        roundTrips: entry.roundTrips,
      });
    }
    return out;
  };

  const offStream = streamBus.onAgentStream(onStream);
  const offDispatch = dispatchEvents.onDispatch(onDispatch);
  const offError = dispatchEvents.onDispatchError(onDispatchError);

  return {
    tracker: { residuals },
    off: () => {
      offStream();
      offDispatch();
      offError();
    },
  };
}

/** Maps one residual to a `CostEvent` with `partial: true`. */
export function toPartialCostEvent(residual: InFlightResidual, runId: string, projectKey?: string): CostEvent {
  const sessionRole = deriveSessionRole(residual.sessionName);
  return {
    ts: Date.now(),
    runId,
    ...(projectKey !== undefined ? { projectKey } : {}),
    schemaVersion: COST_ROW_SCHEMA_VERSION,
    partial: true,
    agentName: residual.agentName,
    model: residual.model,
    // Attributed through sessionRole instead: the native stream carries no
    // storyId/stage, so a partial row falls back to the session's role.
    ...(sessionRole !== undefined ? { sessionRole } : {}),
    ...(residual.stage !== undefined ? { stage: residual.stage } : {}),
    ...(residual.storyId !== undefined ? { storyId: residual.storyId } : {}),
    ...(residual.scopeId !== undefined ? { scopeId: residual.scopeId } : {}),
    callId: residual.streamCallId,
    // Copy, not share: a returned row must not alias the residual's (or the
    // tracker's) mutable token accumulator.
    tokens: { ...residual.tokens },
    roundTrips: residual.roundTrips,
    roundTripUnit: "model-call",
    // Match how the cost subscriber normalises an estimated row (cost.ts):
    // estimated, exact and canonical all carry the residual's cost.
    costUsd: residual.costUsd,
    estimatedCostUsd: residual.costUsd,
    exactCostUsd: residual.costUsd,
    confidence: "estimated",
    durationMs: 0,
  };
}
