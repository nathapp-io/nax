import { isPipelineStage, type PipelineStage } from "@/config";
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

/**
 * A stream event as nax's listeners receive it: the session contract types
 * `stage` as a plain string (S1 spec port 4); the bus re-narrows it to nax's
 * own union before any listener sees it.
 */
export type NaxAgentStreamEvent = AgentStreamEvent & { readonly stage?: PipelineStage };

export type AgentStreamListener = (event: NaxAgentStreamEvent) => void;

function hasNaxStage(event: AgentStreamEvent): event is NaxAgentStreamEvent {
  return event.stage === undefined || isPipelineStage(event.stage);
}

/**
 * Re-narrows `stage`. A known or absent stage passes through as the same
 * object; an unknown label (no producer emits one today) is dropped and logged
 * rather than handed to listeners typed on nax's union.
 */
export function narrowStreamStage(event: AgentStreamEvent): NaxAgentStreamEvent {
  if (hasNaxStage(event)) return event;
  getSafeLogger()?.debug("agent-stream-bus", "dropped an unknown stage label", {
    storyId: event.storyId,
    stage: event.stage,
  });
  return { ...event, stage: undefined };
}

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
    const narrowed = narrowStreamStage(event);
    for (const listener of this._listeners) {
      try {
        listener(narrowed);
      } catch (err) {
        getSafeLogger()?.warn("agent-stream-bus", "listener threw", { error: errorMessage(err) });
      }
    }
  }
}
