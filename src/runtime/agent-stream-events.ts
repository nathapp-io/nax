import type { PipelineStage } from "@/config";
import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";

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
  /**
   * Set when this usage report IS one round trip, which is the native
   * transport's cadence: `turn-loop.ts` emits exactly one per `complete()`.
   *
   * The idle watchdog reads it to classify the event as tool-call-tier
   * activity rather than semantic progress. Without it, a spinning native
   * session reset `lastNonToolCallActivityAt` on every iteration and
   * `toolCallOnlyIdleTimeoutSeconds` — the timer built for exactly that shape
   * — could never expire (nax#2013).
   *
   * Absent on ACP, whose loop is separately bounded by `maxInteractions` and
   * whose usage cadence is the agent's, not nax's.
   */
  readonly perRoundTrip?: true;
  /** Cache-read tokens the provider served from its prompt cache. Absent when
   *  the round trip reported no cache data — never coerced to 0, so "no cache
   *  data" and "zero cache tokens" stay distinguishable. */
  readonly cacheRead?: number;
  /** Cache-creation (write) tokens the round trip billed. Absent when unknown,
   *  for the same reason as `cacheRead`. */
  readonly cacheWrite?: number;
  /** Native only: 1-based index of the round trip this usage covers, within the turn.
   *  Absent on a compaction-summary or retry beat, which are not round-trip boundaries. */
  readonly roundTrip?: number;
  /** Whose cadence this report follows. "round-trip" is nax's own loop (native);
   *  "agent" is the delegated agent's, which is not a nax turn marker (ACP). */
  readonly cadence?: "round-trip" | "agent";
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
