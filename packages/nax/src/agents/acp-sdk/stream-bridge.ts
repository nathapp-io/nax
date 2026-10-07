/**
 * One backend prompt as the runtime stream bus sees it (S4b spec §6.2.1): the
 * same AgentStreamEvent sequence the acpx client emits per prompt
 * (spawn-client-session.ts), built from the backend's turn events. The idle
 * watchdog and in-flight usage read it through onStreamActivity.
 *
 * call_ended is "success" or "error" only, as acpx (D2-g). The stream is an
 * observer: a throwing listener is logged and never reaches the turn.
 */
import { randomUUID } from "node:crypto";
import type { AgentStreamEvent, TurnEvent, TurnEventSink } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";

export interface StreamContext {
  readonly emit: ((event: AgentStreamEvent) => void) | undefined;
  readonly agentName: string;
  readonly sessionName: string;
  /** From OpenSessionOpts.toolAudit.header; "" when the opener supplied none (D2-h). */
  readonly runId: string;
  readonly storyId: string | undefined;
  readonly model: string;
  readonly timeoutSeconds: number;
  /** The live agent process's pid, when known (S4b-3 wires it from onProcess). */
  readonly pid: () => number | undefined;
}

export interface CallBridge {
  readonly callId: string;
  /** The backend's onTurnEvent for this prompt. */
  readonly sink: TurnEventSink;
  /** True once the prompt produced visible text or a tool call (S4b-3 promptRetries reads it). */
  sideEffects(): boolean;
  /** Tells the idle watchdog this call waits on a person (§6.2.1). */
  awaitingHuman(): void;
  /** Emits agent.call_ended once; later calls and events are ignored. */
  end(status: "success" | "error"): void;
}

type UsageEvent = Extract<TurnEvent, { type: "usage" }>;

type Activity =
  | { readonly kind: "agent.message_update"; readonly deltaBytes: number }
  | { readonly kind: "agent.thinking_update"; readonly deltaBytes: number }
  | { readonly kind: "agent.tool_call_update"; readonly toolName?: string }
  | {
      readonly kind: "agent.usage_update";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costUsd?: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
      readonly cadence: "agent";
    };

function toolUpdate(toolName: string | undefined): Activity {
  return toolName === undefined ? { kind: "agent.tool_call_update" } : { kind: "agent.tool_call_update", toolName };
}

function usageActivity(event: UsageEvent): Activity {
  return {
    kind: "agent.usage_update",
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    // An unpriced prompt carries costUsd 0, which is not a cost (turn-event.ts).
    ...(event.costSource === "reported" ? { costUsd: event.costUsd } : {}),
    ...(event.cacheRead === undefined ? {} : { cacheRead: event.cacheRead }),
    ...(event.cacheWrite === undefined ? {} : { cacheWrite: event.cacheWrite }),
    // The delegated agent's cadence, never nax's round-trip loop (nax#2045).
    cadence: "agent",
  };
}

function activityOf(event: TurnEvent, toolNames: Map<string, string>): Activity | undefined {
  switch (event.type) {
    case "text_delta":
      return { kind: "agent.message_update", deltaBytes: Buffer.byteLength(event.text, "utf8") };
    case "thinking_delta":
      return { kind: "agent.thinking_update", deltaBytes: Buffer.byteLength(event.text, "utf8") };
    case "tool_call":
      toolNames.set(event.callId, event.name);
      return toolUpdate(event.name);
    case "tool_progress":
      // An ACP heartbeat while a tool runs: activity for the watchdog (S4b-0 finding f).
      return toolUpdate(toolNames.get(event.callId));
    case "tool_result": {
      const name = toolNames.get(event.callId);
      toolNames.delete(event.callId);
      return toolUpdate(name);
    }
    case "usage":
      return usageActivity(event);
    case "stream_reset":
    case "compaction":
      return undefined;
  }
}

function sender(ctx: StreamContext): (event: AgentStreamEvent) => void {
  return (event) => {
    if (ctx.emit === undefined) return;
    try {
      ctx.emit(event);
    } catch (err) {
      getSafeLogger()?.debug("acp-sdk", "A stream listener threw; the turn continues", {
        sessionName: ctx.sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function startCall(ctx: StreamContext, now: () => number = Date.now): CallBridge {
  const callId = randomUUID();
  const send = sender(ctx);
  const base = {
    callId,
    runId: ctx.runId,
    agentName: ctx.agentName,
    sessionName: ctx.sessionName,
    ...(ctx.storyId === undefined ? {} : { storyId: ctx.storyId }),
  };
  const toolNames = new Map<string, string>();
  let ended = false;
  let sideEffects = false;
  send({ ...base, kind: "agent.call_started", model: ctx.model, timeoutSeconds: ctx.timeoutSeconds, timestamp: now() });
  const pid = ctx.pid();
  if (pid !== undefined) send({ ...base, kind: "agent.process_update", status: "spawned", pid, timestamp: now() });
  return {
    callId,
    sink: (event) => {
      if (ended) return;
      if (event.type === "text_delta" || event.type === "tool_call") sideEffects = true;
      const activity = activityOf(event, toolNames);
      if (activity !== undefined) send({ ...base, ...activity, timestamp: now() });
    },
    sideEffects: () => sideEffects,
    awaitingHuman: () => {
      if (!ended) send({ ...base, kind: "agent.awaiting_human", timestamp: now() });
    },
    end: (status) => {
      if (ended) return;
      ended = true;
      send({ ...base, kind: "agent.call_ended", status, timestamp: now() });
    },
  };
}
