import type { AgentStreamEvent, AgentUsageUpdateEvent, IAgentStreamEventBus } from "../agent-stream-events";
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
 * Forward every `agent.usage_update` to the usage sidecar. Only that kind is
 * switched on: the run log's activity counters (agent-stream-logging.ts) keep
 * their event stream, and the sidecar owns the usage payload.
 */
export function attachUsageAuditSubscriber(
  bus: IAgentStreamEventBus,
  auditor: IUsageAuditor,
  runId: string,
): () => void {
  return bus.onAgentStream((event: AgentStreamEvent) => {
    switch (event.kind) {
      case "agent.usage_update":
        auditor.record(toUsageEntry(event, runId));
        break;
      default:
        break;
    }
  });
}
