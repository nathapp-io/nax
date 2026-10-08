/**
 * S3 session events -> ACP session updates (S5 spec §4.1-§4.3). One translator
 * per turn: it remembers tool calls (for result diffs and permission requests)
 * and approval requests (to fail a call the session mode denied). Permission
 * requests, questions and the turn end are the session's job (S5-2).
 */
import type { SessionUpdate, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { SessionEvent } from "@nathapp/nax-agent";
import { type DiffContent, type ReadOldText, toolDiff } from "#src/server/translate/diff";
import { announce } from "#src/server/translate/notice";
import { toolKind, toolLocations, toolTitle } from "#src/server/translate/tool-kind";

/** Optional session updates the client advertised (`clientCapabilities.session`). */
export interface ClientUpdates {
  readonly notices: boolean;
  readonly compaction: boolean;
}

export interface EventTranslatorDeps {
  readonly cwd: string;
  readonly contextWindow?: number;
  readonly readOldText: ReadOldText;
  readonly clientUpdates: ClientUpdates;
  /** The session's cost before this turn; `usage_update.cost` is the cumulative session cost. */
  readonly priorCostUsd?: number;
}

export interface EventTranslator {
  translate(event: SessionEvent): Promise<readonly SessionUpdate[]>;
  toolCallFor(callId: string): ToolCallUpdate | undefined;
  /** The session's priced cost so far, including this turn's rounds. */
  costUsd(): number;
}

export type UsageEvent = Extract<SessionEvent, { type: "usage" }>;

interface KnownCall {
  readonly name: string;
  readonly input: unknown;
  readonly diff?: DiffContent;
}

interface KnownApproval {
  readonly callId: string;
  readonly reason: string;
}

export function textContent(text: string): Extract<ToolCallContent, { type: "content" }> {
  return { type: "content", content: { type: "text", text } };
}

/** `sessionCostUsd`: the cumulative session cost after this round (ACP `cost.amount` is cumulative). */
export function usageUpdate(
  event: UsageEvent,
  contextWindow: number | undefined,
  sessionCostUsd: number,
): SessionUpdate[] {
  if (contextWindow === undefined) return [];
  const used = event.inputTokens + event.outputTokens + (event.cacheRead ?? 0) + (event.cacheWrite ?? 0);
  return [
    {
      sessionUpdate: "usage_update",
      used,
      size: contextWindow,
      cost: event.costSource === "unpriced" ? null : { amount: sessionCostUsd, currency: "USD" },
      ...(event.costSource !== undefined ? { _meta: { naxAgent: { costSource: event.costSource } } } : {}),
    },
  ];
}

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

function toolResultUpdate(event: EventOf<"tool_result">, diff: DiffContent | undefined): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: event.callId,
    status: event.isError ? "failed" : "completed",
    content: [textContent(event.preview), ...(diff !== undefined ? [diff] : [])],
  };
}

function profileDenial(approval: KnownApproval | undefined, event: EventOf<"approval_resolved">): SessionUpdate[] {
  if (approval === undefined || event.decidedBy !== "profile" || event.decision !== "deny") return [];
  return [
    {
      sessionUpdate: "tool_call_update",
      toolCallId: approval.callId,
      status: "failed",
      content: [textContent(`Denied by the session mode: ${approval.reason}`)],
    },
  ];
}

function streamResetUpdate(event: EventOf<"stream_reset">, notices: boolean): SessionUpdate {
  return announce(
    notices,
    "info",
    "Response restarted",
    `The model stream was retried (attempt ${event.attempt}); text above may repeat.`,
  );
}

export function createEventTranslator(deps: EventTranslatorDeps): EventTranslator {
  const calls = new Map<string, KnownCall>();
  const approvals = new Map<string, KnownApproval>();
  let compactions = 0;
  let sessionCostUsd = deps.priorCostUsd ?? 0;

  const describeCall = (toolCallId: string, call: KnownCall) => {
    const locations = toolLocations(call.name, call.input, deps.cwd);
    return {
      toolCallId,
      title: toolTitle(call.name, call.input),
      kind: toolKind(call.name),
      rawInput: call.input,
      ...(locations !== undefined ? { locations } : {}),
      ...(call.diff !== undefined ? { content: [call.diff] } : {}),
    };
  };

  async function toolCallUpdate(event: EventOf<"tool_call">): Promise<SessionUpdate> {
    const diff = await toolDiff(event.name, event.input, deps.cwd, deps.readOldText);
    const call: KnownCall = { name: event.name, input: event.input, ...(diff !== undefined ? { diff } : {}) };
    calls.set(event.callId, call);
    return { sessionUpdate: "tool_call", ...describeCall(event.callId, call), status: "in_progress" };
  }

  function usage(event: EventOf<"usage">): SessionUpdate[] {
    if (event.costSource !== "unpriced") sessionCostUsd += event.costUsd;
    return usageUpdate(event, deps.contextWindow, sessionCostUsd);
  }

  function compaction(event: EventOf<"compaction">): SessionUpdate[] {
    if (!deps.clientUpdates.compaction) return [];
    compactions += 1;
    return [
      {
        sessionUpdate: "compaction_update",
        compactionId: `${event.turnId}-${compactions}`,
        status: "completed",
        _meta: { naxAgent: { reason: event.reason } },
      },
    ];
  }

  function resolved(event: EventOf<"approval_resolved">): SessionUpdate[] {
    const approval = approvals.get(event.requestId);
    approvals.delete(event.requestId);
    return profileDenial(approval, event);
  }

  async function translate(event: SessionEvent): Promise<readonly SessionUpdate[]> {
    switch (event.type) {
      case "text_delta":
        return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } }];
      case "thinking_delta":
        return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } }];
      case "stream_reset":
        return [streamResetUpdate(event, deps.clientUpdates.notices)];
      case "tool_call":
        return [await toolCallUpdate(event)];
      case "tool_result":
        return [toolResultUpdate(event, calls.get(event.callId)?.diff)];
      case "usage":
        return usage(event);
      case "compaction":
        return compaction(event);
      case "approval_requested":
        if (event.callId !== undefined) approvals.set(event.requestId, { callId: event.callId, reason: event.reason });
        return [];
      case "approval_resolved":
        return resolved(event);
      case "turn_start":
      case "question":
      case "turn_end":
        return [];
    }
  }

  return {
    translate,
    costUsd: () => sessionCostUsd,
    toolCallFor(callId) {
      const call = calls.get(callId);
      return call === undefined ? undefined : { ...describeCall(callId, call), status: "pending" };
    },
  };
}
