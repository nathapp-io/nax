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

/** How often (ms) to flush buffered stream events into React state. */
const RENDER_INTERVAL_MS = 150;

export function useAgentStreamEvents(bus?: IAgentStreamEventBus | null): {
  activeCalls: Map<string, ActiveCallState>;
  inputTokens: number;
  outputTokens: number;
} {
  // Refs hold the latest in-flight state — updated synchronously on every event,
  // never trigger re-renders directly.
  const activeCallsRef = useRef<Map<string, ActiveCallState>>(new Map());
  const inputTokensRef = useRef(0);
  const outputTokensRef = useRef(0);
  const lastTokensRef = useRef<Map<string, { input: number; output: number }>>(new Map());
  const dirtyRef = useRef(false);

  // State holds the displayed snapshot — drained from refs at RENDER_INTERVAL_MS.
  const [activeCalls, setActiveCalls] = useState<Map<string, ActiveCallState>>(new Map());
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);

  // Subscribe to stream events: process into refs only, no setState.
  useEffect(() => {
    if (!bus) return;

    const unsubscribe = bus.onAgentStream((event: AgentStreamEvent) => {
      // Mutate the ref's Map directly — the render-facing snapshot is taken
      // separately in the drain effect below, so copying per event (at token
      // rate) bought nothing. Values are still replaced rather than mutated,
      // so memoized consumers keyed on a call object still see changes.
      const next = activeCallsRef.current;

      switch (event.kind) {
        case "agent.call_started": {
          next.set(event.callId, {
            callId: event.callId,
            agentName: event.agentName,
            storyId: event.storyId,
            stage: event.stage,
            startedAt: event.timestamp,
            lastActivityAt: event.timestamp,
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
          // ACP emits cumulative totals per call — add only the delta.
          {
            const last = lastTokensRef.current.get(event.callId) ?? { input: 0, output: 0 };
            const newInput = event.inputTokens ?? last.input;
            const newOutput = event.outputTokens ?? last.output;
            const deltaIn = newInput - last.input;
            const deltaOut = newOutput - last.output;
            lastTokensRef.current.set(event.callId, { input: newInput, output: newOutput });
            if (deltaIn > 0) inputTokensRef.current += deltaIn;
            if (deltaOut > 0) outputTokensRef.current += deltaOut;
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
          next.delete(event.callId);
          lastTokensRef.current.delete(event.callId);
          break;
        }
        default:
          break;
      }

      dirtyRef.current = true;
    });

    return () => {
      unsubscribe();
      // Drop per-call state so a torn-down bus cannot strand entries whose
      // agent.call_ended never arrived.
      activeCallsRef.current.clear();
      lastTokensRef.current.clear();
    };
  }, [bus]);

  // Drain refs into state at a fixed interval — decouples render rate from event rate.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setActiveCalls(new Map(activeCallsRef.current));
      setInputTokens(inputTokensRef.current);
      setOutputTokens(outputTokensRef.current);
    }, RENDER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return { activeCalls, inputTokens, outputTokens };
}
