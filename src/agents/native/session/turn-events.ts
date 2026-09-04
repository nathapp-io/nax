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
 * forever, which emits `tool` on every iteration and trips
 * `toolCallOnlyIdleTimeout`.
 */

import type { AgentStreamEvent } from "@/runtime/agent-stream-events";

export type NativeTurnActivity =
  | { kind: "message"; bytes: number }
  | { kind: "thinking"; bytes: number }
  | { kind: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
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
      };
    case "tool":
      return { ...common, kind: "agent.tool_call_update", toolName: activity.toolName };
  }
}
