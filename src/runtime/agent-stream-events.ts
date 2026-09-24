import type { PipelineStage } from "@/config";
import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";

export interface AgentStreamEventBase {
  /**
   * Stream-local UUID minted per turn by the emitting adapter
   * (`adapter.ts` `randomUUID()`, mirrored by ACP per prompt). It is the
   * watchdog's and `onActiveCall`'s handle and is NOT a durable join key.
   */
  readonly callId: string;
  readonly runId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: PipelineStage;
  readonly pid?: number;
  readonly timestamp: number;
  /**
   * The exact join key for this dispatch: the same value as the transcript's
   * `owner` and the cost ledger's `scopeId`. Native only, because only native
   * carries a `transcriptOwner` (ACP ignores it). It is deliberately NOT the
   * sibling `callId`, which is a stream-local UUID — joining on `callId` is the
   * mistake that produced nax#2045's 0-of-1,940 match rate.
   *
   * Absent means "unknown", never a coerced `""` and never the `callId`. An
   * absent key must not be joined on; a present-but-wrong key would silently
   * corrupt the join.
   */
  readonly scopeId?: string;
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

/**
 * US-004: the native turn is waiting on a human approval prompt. Emitted as
 * activity from the turn loop while a prompt is pending so the idle watchdog
 * does not read legitimate human waiting as idleness. Carries no payload — the
 * timestamp is all the watchdog reads.
 */
export interface AgentAwaitingHumanEvent extends AgentStreamEventBase {
  readonly kind: "agent.awaiting_human";
}

export type AgentStreamEvent =
  | AgentCallStartedEvent
  | AgentMessageUpdateEvent
  | AgentThinkingUpdateEvent
  | AgentUsageUpdateEvent
  | AgentToolCallUpdateEvent
  | AgentProcessUpdateEvent
  | AgentCallEndedEvent
  | AgentAwaitingHumanEvent;

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
