/**
 * Native round-trip activity -> AgentStreamEvent.
 *
 * The idle watchdog subscribes to the runtime stream bus and tracks calls from
 * these events; nothing under src/agents/native/ emitted any, so
 * `agent.idleWatchdog` was inert on every native session in both modes.
 *
 * Native has no token streaming — one `complete()` is a single call — so these
 * are emitted at round-trip boundaries rather than continuously. That is
 * sufficient: a HUNG call is already bounded by the per-call abort, and the
 * watchdog's unique job is the productive-looking loop that keeps calling tools
 * forever. That loop emits `tool` AND `usage` on every iteration, so the usage
 * event carries `perRoundTrip` to mark it as a round-trip boundary rather than
 * semantic progress — otherwise it reset `lastNonToolCallActivityAt` every
 * iteration and `toolCallOnlyIdleTimeout` could never fire (nax#2013).
 */

import type { AgentStreamEvent } from "@/runtime/agent-stream-events";

export type NativeTurnActivity =
  | { kind: "message"; bytes: number }
  | { kind: "thinking"; bytes: number }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      /** Absent when the round trip reported no cache data — never coerced to 0. */
      cacheRead?: number;
      /** Absent when the round trip reported no cache data — never coerced to 0. */
      cacheWrite?: number;
      /** 1-based ordinal of the round trip this beat covers. Absent on a
       *  compaction-summary or retry beat, which are not round-trip boundaries. */
      roundTrip?: number;
    }
  | { kind: "tool"; toolName: string };

export interface NativeStreamEventBase {
  readonly callId: string;
  readonly runId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: import("@/config").PipelineStage;
}

export function buildNativeStreamEvent(
  base: NativeStreamEventBase,
  activity: NativeTurnActivity,
  timestamp: number,
): AgentStreamEvent {
  const common = { ...base, timestamp };
  switch (activity.kind) {
    case "message":
      return { ...common, kind: "agent.message_update", deltaBytes: activity.bytes };
    case "thinking":
      return { ...common, kind: "agent.thinking_update", deltaBytes: activity.bytes };
    case "usage":
      return {
        ...common,
        kind: "agent.usage_update",
        inputTokens: activity.inputTokens,
        outputTokens: activity.outputTokens,
        costUsd: activity.costUsd,
        ...(activity.cacheRead !== undefined ? { cacheRead: activity.cacheRead } : {}),
        ...(activity.cacheWrite !== undefined ? { cacheWrite: activity.cacheWrite } : {}),
        // Only a real round-trip boundary may claim `perRoundTrip` and an
        // ordinal: the compaction-summary and transport-retry beats are usage
        // events too, but they are not round trips (nax#2013, nax#2045). The
        // cadence is still nax's own loop even on those beats.
        ...(activity.roundTrip !== undefined ? { roundTrip: activity.roundTrip, perRoundTrip: true as const } : {}),
        cadence: "round-trip",
      };
    case "tool":
      return { ...common, kind: "agent.tool_call_update", toolName: activity.toolName };
  }
}
