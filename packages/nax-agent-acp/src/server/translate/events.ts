/**
 * S3 session events -> ACP session updates (S5 spec §4.1-§4.3). One translator
 * per turn: it remembers tool calls (for result diffs and permission requests)
 * and approval requests (to fail a call the session mode denied). Permission
 * requests, questions and the turn end are the session's job (S5-2).
 */
import type { SessionUpdate, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { SessionEvent } from "@nathapp/nax-agent";
import { type DiffContent, type ReadOldText, toolDiff } from "#src/server/translate/diff";
import { notice } from "#src/server/translate/notice";
import { toolKind, toolLocations, toolTitle } from "#src/server/translate/tool-kind";

export interface EventTranslatorDeps {
  readonly cwd: string;
  readonly contextWindow?: number;
  readonly readOldText: ReadOldText;
}

export interface EventTranslator {
  translate(event: SessionEvent): Promise<readonly SessionUpdate[]>;
  toolCallFor(callId: string): ToolCallUpdate | undefined;
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

export function usageUpdate(event: UsageEvent, contextWindow: number | undefined): SessionUpdate[] {
  if (contextWindow === undefined) return [];
  const used = event.inputTokens + event.outputTokens + (event.cacheRead ?? 0) + (event.cacheWrite ?? 0);
  return [
    {
      sessionUpdate: "usage_update",
      used,
      size: contextWindow,
      cost: event.costSource === "unpriced" ? null : { amount: event.costUsd, currency: "USD" },
      ...(event.costSource !== undefined ? { _meta: { naxAgent: { costSource: event.costSource } } } : {}),
    },
  ];
}

export function createEventTranslator(deps: EventTranslatorDeps): EventTranslator {
  const calls = new Map<string, KnownCall>();
  const approvals = new Map<string, KnownApproval>();
  let compactions = 0;

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

  async function translate(event: SessionEvent): Promise<readonly SessionUpdate[]> {
    switch (event.type) {
      case "text_delta":
        return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } }];
      case "thinking_delta":
        return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } }];
      case "stream_reset":
        return [
          notice(
            "info",
            "Response restarted",
            `The model stream was retried (attempt ${event.attempt}); text above may repeat.`,
          ),
        ];
      case "tool_call": {
        const diff = await toolDiff(event.name, event.input, deps.cwd, deps.readOldText);
        const call: KnownCall = { name: event.name, input: event.input, ...(diff !== undefined ? { diff } : {}) };
        calls.set(event.callId, call);
        return [{ sessionUpdate: "tool_call", ...describeCall(event.callId, call), status: "in_progress" }];
      }
      case "tool_result": {
        const diff = calls.get(event.callId)?.diff;
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.callId,
            status: event.isError ? "failed" : "completed",
            content: [textContent(event.preview), ...(diff !== undefined ? [diff] : [])],
          },
        ];
      }
      case "usage":
        return usageUpdate(event, deps.contextWindow);
      case "compaction":
        compactions += 1;
        return [
          {
            sessionUpdate: "compaction_update",
            compactionId: `${event.turnId}-${compactions}`,
            status: "completed",
            _meta: { naxAgent: { reason: event.reason } },
          },
        ];
      case "approval_requested":
        if (event.callId !== undefined) approvals.set(event.requestId, { callId: event.callId, reason: event.reason });
        return [];
      case "approval_resolved": {
        const approval = approvals.get(event.requestId);
        approvals.delete(event.requestId);
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
      case "turn_start":
      case "question":
      case "turn_end":
        return [];
    }
  }

  return {
    translate,
    toolCallFor(callId) {
      const call = calls.get(callId);
      return call === undefined ? undefined : { ...describeCall(callId, call), status: "pending" };
    },
  };
}
