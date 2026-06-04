import type { AgentStreamEvent, IAgentStreamEventBus } from "@/runtime";
import { useEffect, useRef, useState } from "react";

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
  /** Model used for this call (from agent.call_started) */
  model?: string;
  /** Most recently called tool name (from agent.tool_call_update) */
  lastToolName?: string;
}

export function useAgentStreamEvents(bus?: IAgentStreamEventBus | null): {
  activeCalls: Map<string, ActiveCallState>;
  inputTokens: number;
  outputTokens: number;
} {
  const [activeCalls, setActiveCalls] = useState<Map<string, ActiveCallState>>(new Map());
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  // Track the last cumulative token counts per callId so we add only the delta.
  // ACP emits usage_update with cumulative totals, not incremental deltas.
  const lastTokensRef = useRef<Map<string, { input: number; output: number }>>(new Map());

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
              model: event.model,
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
            // Add only the delta: ACP usage_update carries cumulative totals per call.
            {
              const last = lastTokensRef.current.get(event.callId) ?? { input: 0, output: 0 };
              const newInput = event.inputTokens ?? last.input;
              const newOutput = event.outputTokens ?? last.output;
              const deltaIn = newInput - last.input;
              const deltaOut = newOutput - last.output;
              lastTokensRef.current.set(event.callId, { input: newInput, output: newOutput });
              if (deltaIn > 0) setInputTokens((prev) => prev + deltaIn);
              if (deltaOut > 0) setOutputTokens((prev) => prev + deltaOut);
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
                lastToolName: event.toolName,
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
            // Release the per-call token baseline to prevent unbounded map growth
            lastTokensRef.current.delete(event.callId);
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

  return { activeCalls, inputTokens, outputTokens };
}
