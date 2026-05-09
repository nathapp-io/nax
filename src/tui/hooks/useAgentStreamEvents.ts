import { useEffect, useState } from "react";
import type { AgentStreamEvent, IAgentStreamEventBus } from "../../runtime/agent-stream-events";

export interface ActiveCallState {
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
  status: "active" | "ended";
}

export function useAgentStreamEvents(bus?: IAgentStreamEventBus | null): {
  activeCalls: Map<string, ActiveCallState>;
} {
  const [activeCalls, setActiveCalls] = useState<Map<string, ActiveCallState>>(new Map());

  useEffect(() => {
    if (!bus) return;

    const unsubscribe = bus.onAgentStream((event: AgentStreamEvent) => {
      setActiveCalls((prev) => {
        const next = new Map(prev);

        switch (event.kind) {
          case "agent.call_started": {
            const now = event.timestamp;
            next.set(event.callId, {
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
              status: "active",
            });
            break;
          }
          case "agent.message_update": {
            const state = next.get(event.callId);
            if (state) {
              next.set(event.callId, {
                ...state,
                messageUpdates: state.messageUpdates + 1,
                lastActivityAt: event.timestamp,
              });
            }
            break;
          }
          case "agent.thinking_update": {
            const state = next.get(event.callId);
            if (state) {
              next.set(event.callId, {
                ...state,
                thinkingUpdates: state.thinkingUpdates + 1,
                lastActivityAt: event.timestamp,
              });
            }
            break;
          }
          case "agent.usage_update": {
            const state = next.get(event.callId);
            if (state) {
              next.set(event.callId, {
                ...state,
                usageUpdates: state.usageUpdates + 1,
                lastActivityAt: event.timestamp,
              });
            }
            break;
          }
          case "agent.tool_call_update": {
            const state = next.get(event.callId);
            if (state) {
              next.set(event.callId, {
                ...state,
                toolCallUpdates: state.toolCallUpdates + 1,
                lastActivityAt: event.timestamp,
              });
            }
            break;
          }
          case "agent.call_ended": {
            const state = next.get(event.callId);
            if (state) {
              next.set(event.callId, { ...state, status: "ended" });
              // Remove ended calls to keep the map clean
              next.delete(event.callId);
            }
            break;
          }
          default:
            break;
        }

        return next;
      });
    });

    return unsubscribe;
  }, [bus]);

  return { activeCalls };
}
