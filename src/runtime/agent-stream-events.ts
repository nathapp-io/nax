import type { PipelineStage } from "../config/permissions";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";

export interface AgentStreamEventBase {
  readonly callId: string;
  readonly runId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: PipelineStage;
  readonly pid?: number;
  readonly timestamp: number;
}

export interface AgentCallStartedEvent extends AgentStreamEventBase {
  readonly kind: "agent.call_started";
  readonly model: string;
  readonly timeoutSeconds: number;
}

export interface AgentMessageUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.message_update";
  readonly deltaBytes?: number;
}

export interface AgentThinkingUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.thinking_update";
  readonly deltaBytes?: number;
}

export interface AgentUsageUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.usage_update";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface AgentToolCallUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.tool_call_update";
  readonly toolName?: string;
}

export interface AgentProcessUpdateEvent extends AgentStreamEventBase {
  readonly kind: "agent.process_update";
  readonly status: "spawned" | "stderr" | "cancelled" | "exited";
  readonly exitCode?: number;
}

export interface AgentCallEndedEvent extends AgentStreamEventBase {
  readonly kind: "agent.call_ended";
  readonly status: "success" | "error" | "cancelled" | "timeout";
  readonly exitCode?: number;
}

export type AgentStreamEvent =
  | AgentCallStartedEvent
  | AgentMessageUpdateEvent
  | AgentThinkingUpdateEvent
  | AgentUsageUpdateEvent
  | AgentToolCallUpdateEvent
  | AgentProcessUpdateEvent
  | AgentCallEndedEvent;

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
