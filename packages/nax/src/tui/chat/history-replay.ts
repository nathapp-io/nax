/** Pure opening-snapshot replay. Tool data uses the same masking and caps as live turns. */
import { displayToolInput, toolResultPreview } from "@nathapp/nax-agent";
import { COMPACTION_SUMMARY_PREFIX } from "@nathapp/nax-agent/internal";
import { acpAgentOfMessage, type ChatHistory, parseMentionMessage, parseSkillInvocation } from "@/chat";
import { mentionTranscriptEntries } from "./mention-entries";
import type { TranscriptEntry } from "./transcript-model";

type Message = ChatHistory["messages"][number];
type StoredResult = Extract<Message, { role: "tool-result" }>;
type StoredCall = NonNullable<Extract<Message, { role: "assistant" }>["toolCalls"]>[number];

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const NO_RESULT_TEXT = "No result was recorded for this call.";

function replayUser(content: string): TranscriptEntry[] {
  if (content === "") return [];
  if (content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return [{ kind: "notice", text: "earlier conversation compacted" }];
  }
  const skill = parseSkillInvocation(content);
  if (skill) return [{ kind: "skill", ...skill }];
  // A stored message nax expanded replays as the same rows a live turn drew for it; one that
  // does not parse — a message typed before mentions existed — stays the plain message.
  const mention = parseMentionMessage(content);
  return mention === undefined ? [{ kind: "user", text: content }] : [...mentionTranscriptEntries(mention)];
}

function replayCall(
  call: StoredCall,
  result: StoredResult | undefined,
  timing: { turnId: string; timestamp: string },
): TranscriptEntry {
  return {
    kind: "tool",
    turnId: timing.turnId,
    callId: call.id,
    name: call.name,
    input: displayToolInput(call.input),
    status: result === undefined || result.isError ? "error" : "ok",
    preview: result === undefined ? NO_RESULT_TEXT : toolResultPreview(result.content),
    startedAt: timing.timestamp,
    endedAt: timing.timestamp,
    children: [],
  };
}

const ACP_TOOL_PREFIX = "[tool] ";
const ACP_ERROR_SUFFIX = " (error)";
const ACP_OVERFLOW = /^… and (\d+) more$/;

function replayAcpLine(line: string, n: number, timing: { turnId: string; timestamp: string }): TranscriptEntry {
  const body = line.slice(ACP_TOOL_PREFIX.length);
  const overflow = ACP_OVERFLOW.exec(body);
  if (overflow) return { kind: "notice", text: `… and ${overflow[1]} more tool calls` };
  const failed = body.endsWith(ACP_ERROR_SUFFIX);
  return {
    kind: "tool",
    turnId: timing.turnId,
    callId: `${timing.turnId}-acp-${n}`,
    name: failed ? body.slice(0, -ACP_ERROR_SUFFIX.length) : body,
    input: {},
    status: failed ? "error" : "ok",
    startedAt: timing.timestamp,
    endedAt: timing.timestamp,
    children: [],
  };
}

/** An ACP reply is its text followed by the trailing run of `[tool] ` lines the recorder wrote. */
function replayAcpAssistant(content: string, timing: { turnId: string; timestamp: string }): TranscriptEntry[] {
  const lines = content.split("\n");
  let start = lines.length;
  while (start > 0 && lines[start - 1].startsWith(ACP_TOOL_PREFIX)) start--;
  const text = lines.slice(0, start).join("\n");
  const entries: TranscriptEntry[] = text === "" ? [] : [{ kind: "reply", turnId: timing.turnId, text }];
  for (const [n, line] of lines.slice(start).entries()) entries.push(replayAcpLine(line, n, timing));
  return entries;
}

function replayMessage(
  message: Message,
  results: ReadonlyMap<string, StoredResult>,
  timing: { turnId: string; timestamp: string },
): TranscriptEntry[] {
  switch (message.role) {
    case "user":
      return replayUser(message.content);
    case "assistant": {
      if (acpAgentOfMessage(message) !== undefined) return replayAcpAssistant(message.content, timing);
      const entries: TranscriptEntry[] = [];
      if (message.content !== "") entries.push({ kind: "reply", turnId: timing.turnId, text: message.content });
      for (const call of message.toolCalls ?? []) entries.push(replayCall(call, results.get(call.id), timing));
      return entries;
    }
    default:
      // Results only annotate calls; unknown future roles do not stop replay.
      return [];
  }
}

/** Render stored messages without thinking, running cards, or unbounded tool data. */
export function replayHistory(history: ChatHistory): readonly TranscriptEntry[] {
  const results = new Map<string, StoredResult>();
  for (const message of history.messages) {
    if (message.role === "tool-result") results.set(message.toolCallId, message);
  }
  const timestamp = history.savedAt ?? FALLBACK_TIMESTAMP;
  return history.messages.flatMap((message, index) =>
    replayMessage(message, results, { turnId: `history-${index}`, timestamp }),
  );
}
