import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import type { AgentStreamEvent } from "../agents/agent-stream-event-types";

export type {
  AgentAwaitingHumanEvent,
  AgentCallEndedEvent,
  AgentCallStartedEvent,
  AgentMessageUpdateEvent,
  AgentProcessUpdateEvent,
  AgentStreamEvent,
  AgentStreamEventBase,
  AgentThinkingUpdateEvent,
  AgentToolCallUpdateEvent,
  AgentUsageUpdateEvent,
} from "../agents/agent-stream-event-types";

export type AgentStreamListener = (event: AgentStreamEvent) => void;

export interface IAgentStreamEventBus {
  onAgentStream(listener: AgentStreamListener): () => void;
  emitAgentStream(event: AgentStreamEvent): void;
}

export class AgentStreamEventBus implements IAgentStreamEventBus {
  private readonly _listeners = new Set<AgentStreamListener>();

  onAgentStream(listener: AgentStreamListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  emitAgentStream(event: AgentStreamEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (err) {
        getSafeLogger()?.warn("agent-stream-bus", "listener threw", { error: errorMessage(err) });
      }
    }
  }
}
