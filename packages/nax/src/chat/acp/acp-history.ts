/**
 * An ACP turn as native messages.
 *
 * A chat session's native document (`TranscriptDoc.messages`) is what a resumed
 * session replays. An ACP agent keeps its own history, so these pure functions
 * turn one ACP turn into a user/assistant pair the native document can hold:
 * the assistant message carries the reply text and one `[tool] <name>` line
 * per tool call, stamped with an ACP `origin`. Tool inputs, results and
 * thinking are never recorded.
 */
import type { SessionEvent, TranscriptDoc } from "@nathapp/nax-agent";
import { ACP_CHAT_AGENTS, type AcpChatAgent, type ChatAcpModel } from "./acp-model";

export type ChatMessage = TranscriptDoc["messages"][number];

/** Tool lines written for one turn before the rest are summarised as a count. */
export const ACP_TOOL_SUMMARY_LIMIT = 20;
/** Code points of a tool name written to its line. */
export const ACP_TOOL_NAME_MAX_CHARS = 80;

const ORIGIN_PREFIX = "acp:";
const DEFAULT_MODEL = "default";
const SEGMENT_SEPARATOR = "\n\n";

/** `{ provider: "acp:<agent>", model: acp.model ?? "default" }`; the effort is not part of it. */
export function acpOrigin(acp: ChatAcpModel): { readonly provider: string; readonly model: string } {
  return { provider: `${ORIGIN_PREFIX}${acp.agent}`, model: acp.model ?? DEFAULT_MODEL };
}

function isAcpChatAgent(text: string): text is AcpChatAgent {
  return ACP_CHAT_AGENTS.some((agent) => agent === text);
}

/** The ACP chat agent that wrote an assistant message, from `origin.provider`; undefined otherwise. */
export function acpAgentOfMessage(message: ChatMessage): AcpChatAgent | undefined {
  if (message.role !== "assistant") return undefined;
  const provider = message.origin?.provider;
  if (provider === undefined || !provider.startsWith(ORIGIN_PREFIX)) return undefined;
  const agent = provider.slice(ORIGIN_PREFIX.length);
  return isAcpChatAgent(agent) ? agent : undefined;
}

type TurnEndEvent = Extract<SessionEvent, { readonly type: "turn_end" }>;

interface ToolCallRecord {
  readonly callId: string;
  readonly name: string;
}

/** The turn's `text_delta` text after the last `stream_reset`, split at each `tool_call`. */
function replySegments(events: readonly SessionEvent[]): string[] {
  let segments: string[] = [];
  let current = "";
  for (const event of events) {
    if (event.type === "text_delta") current += event.text;
    else if (event.type === "stream_reset") {
      segments = [];
      current = "";
    } else if (event.type === "tool_call") {
      segments.push(current);
      current = "";
    }
  }
  segments.push(current);
  return segments.filter((segment) => segment !== "");
}

/** The reply segments joined with a blank line; `turn_end.output` only when the deltas hold no text. */
function replyText(events: readonly SessionEvent[], turnEnd: TurnEndEvent | undefined): string {
  const segments = replySegments(events);
  return segments.length > 0 ? segments.join(SEGMENT_SEPARATOR) : (turnEnd?.output ?? "");
}

function toolCallsOf(events: readonly SessionEvent[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const event of events) {
    if (event.type === "tool_call") calls.push({ callId: event.callId, name: event.name });
  }
  return calls;
}

function erroredCallIds(events: readonly SessionEvent[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "tool_result" && event.isError) ids.add(event.callId);
  }
  return ids;
}

function toolLines(events: readonly SessionEvent[]): string[] {
  const calls = toolCallsOf(events);
  const errored = erroredCallIds(events);
  const lines = calls.slice(0, ACP_TOOL_SUMMARY_LIMIT).map((call) => {
    const name = Array.from(call.name).slice(0, ACP_TOOL_NAME_MAX_CHARS).join("");
    return `[tool] ${name}${errored.has(call.callId) ? " (error)" : ""}`;
  });
  if (calls.length > ACP_TOOL_SUMMARY_LIMIT) {
    lines.push(`[tool] … and ${calls.length - ACP_TOOL_SUMMARY_LIMIT} more`);
  }
  return lines;
}

function assistantContent(events: readonly SessionEvent[]): string {
  const turnEnd = events.findLast((event): event is TurnEndEvent => event.type === "turn_end");
  const text = replyText(events, turnEnd);
  const lines = toolLines(events);
  if (text === "" && lines.length === 0) return `(no reply; turn ${turnEnd?.status ?? "unknown"})`;
  return [...(text === "" ? [] : [text]), ...lines].join("\n");
}

/** The user message and the assistant message that record one ACP turn. */
export function acpTurnMessages(input: {
  readonly message: string;
  readonly events: readonly SessionEvent[];
  readonly acp: ChatAcpModel;
}): readonly [ChatMessage, ChatMessage] {
  return [
    { role: "user", content: input.message },
    { role: "assistant", content: assistantContent(input.events), origin: acpOrigin(input.acp) },
  ];
}
