import type { AgentStreamEvent, AgentUsageUpdateEvent, IAgentStreamEventBus } from "../agent-stream-events";
import type { DispatchEvent, IDispatchEventBus } from "../dispatch-events";
import type { IUsageAuditor, UsageAuditEntry } from "../usage-auditor";

function toUsageEntry(event: AgentUsageUpdateEvent, runId: string): UsageAuditEntry {
  return {
    ts: event.timestamp,
    runId,
    scopeId: event.scopeId,
    streamCallId: event.callId,
    sessionName: event.sessionName,
    storyId: event.storyId,
    stage: event.stage,
    agentName: event.agentName,
    roundTrip: event.roundTrip,
    cadence: event.cadence,
    input: event.inputTokens,
    output: event.outputTokens,
    cacheRead: event.cacheRead,
    cacheWrite: event.cacheWrite,
    costUsd: event.costUsd,
  };
}

/**
 * A one-shot `complete()` dispatch emits no `agent.usage_update`, so without
 * this projection the usage sidecar would only ever see stream beats and a
 * completed run's one-shot spend would be invisible. Map the dispatch event
 * onto the same row shape the stream beats use, tagged `cadence: "one-shot"`.
 */
function toOneShotEntry(event: DispatchEvent, runId: string): UsageAuditEntry | null {
  if (event.kind !== "complete") return null;
  const tu = event.tokenUsage;
  const wireExact = event.exactCostUsd;
  const costUsd = typeof wireExact === "number" && Number.isFinite(wireExact) ? wireExact : event.estimatedCostUsd;
  // Mirrors the cost subscriber: a complete dispatch with no token usage and
  // zero cost carries nothing worth a row. A non-finite exact cost is treated
  // as absent, the same way attachCostSubscriber does.
  if (!tu && (costUsd ?? 0) === 0) return null;
  return {
    ts: event.timestamp,
    runId,
    scopeId: event.scopeId,
    streamCallId: event.callId ?? "one-shot",
    sessionName: event.sessionName,
    storyId: event.storyId,
    stage: event.stage,
    agentName: event.agentName,
    cadence: "one-shot",
    input: tu?.inputTokens,
    output: tu?.outputTokens,
    cacheRead: tu?.cacheReadInputTokens,
    cacheWrite: tu?.cacheCreationInputTokens,
    costUsd,
  };
}

/**
 * Forward every `agent.usage_update` and every one-shot `complete` dispatch to
 * the usage sidecar. Only those two kinds are switched on: the run log's
 * activity counters (agent-stream-logging.ts) keep their event stream, and the
 * sidecar owns the usage payload.
 */
export function attachUsageAuditSubscriber(
  bus: IAgentStreamEventBus,
  dispatchEvents: IDispatchEventBus,
  auditor: IUsageAuditor,
  runId: string,
): () => void {
  const offStream = bus.onAgentStream((event: AgentStreamEvent) => {
    switch (event.kind) {
      case "agent.usage_update":
        auditor.record(toUsageEntry(event, runId));
        break;
      default:
        break;
    }
  });

  const offDispatch = dispatchEvents.onDispatch((event: DispatchEvent) => {
    const entry = toOneShotEntry(event, runId);
    if (entry) auditor.record(entry);
  });

  return () => {
    offStream();
    offDispatch();
  };
}
