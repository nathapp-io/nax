import { getSafeLogger } from "../../logger";
import type { AgentStreamEvent, IAgentStreamEventBus } from "../agent-stream-events";

interface CallTrackingState {
  callId: string;
  agentName: string;
  storyId?: string;
  stage?: string;
  startedAt: number;
  lastActivityAt: number;
  messageUpdates: number;
  thinkingUpdates: number;
  usageUpdates: number;
  toolCallUpdates: number;
}

export function attachAgentStreamLogging(bus: IAgentStreamEventBus, runId: string): () => void {
  const activeCalls = new Map<string, CallTrackingState>();

  return bus.onAgentStream((event: AgentStreamEvent) => {
    switch (event.kind) {
      case "agent.call_started": {
        const now = event.timestamp;
        activeCalls.set(event.callId, {
          callId: event.callId,
          agentName: event.agentName,
          storyId: event.storyId,
          stage: event.stage,
          startedAt: now,
          lastActivityAt: now,
          messageUpdates: 0,
          thinkingUpdates: 0,
          usageUpdates: 0,
          toolCallUpdates: 0,
        });
        getSafeLogger()?.info("agent-stream", "Agent call started", {
          storyId: event.storyId,
          runId,
          callId: event.callId,
          agentName: event.agentName,
          stage: event.stage,
          model: event.model,
          timeoutSeconds: event.timeoutSeconds,
        });
        break;
      }
      case "agent.message_update": {
        const state = activeCalls.get(event.callId);
        if (state) {
          state.messageUpdates++;
          state.lastActivityAt = event.timestamp;
        }
        break;
      }
      case "agent.thinking_update": {
        const state = activeCalls.get(event.callId);
        if (state) {
          state.thinkingUpdates++;
          state.lastActivityAt = event.timestamp;
        }
        break;
      }
      case "agent.usage_update": {
        const state = activeCalls.get(event.callId);
        if (state) {
          state.usageUpdates++;
          state.lastActivityAt = event.timestamp;
        }
        break;
      }
      case "agent.tool_call_update": {
        const state = activeCalls.get(event.callId);
        if (state) {
          state.toolCallUpdates++;
          state.lastActivityAt = event.timestamp;
        }
        break;
      }
      case "agent.process_update":
        // Intentionally ignored — process lifecycle events are not activity signals
        break;
      case "agent.call_ended": {
        const state = activeCalls.get(event.callId);
        if (state) {
          const idleMs = event.timestamp - state.lastActivityAt;
          getSafeLogger()?.info("agent-stream", "Agent call ended", {
            storyId: state.storyId,
            runId,
            callId: state.callId,
            agentName: state.agentName,
            stage: state.stage,
            messageUpdates: state.messageUpdates,
            thinkingUpdates: state.thinkingUpdates,
            usageUpdates: state.usageUpdates,
            toolCallUpdates: state.toolCallUpdates,
            lastActivityAt: state.lastActivityAt,
            idleMs,
            status: event.status,
          });
          activeCalls.delete(event.callId);
        }
        break;
      }
    }
  });
}
