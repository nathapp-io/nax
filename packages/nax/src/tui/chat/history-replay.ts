/** Pure opening-snapshot replay. Tool data uses the same masking and caps as live turns. */
import { displayToolInput, toolResultPreview } from "@nathapp/nax-agent";
import { COMPACTION_SUMMARY_PREFIX } from "@nathapp/nax-agent/internal";
import type { ChatHistory } from "@/chat";
import type { TranscriptEntry } from "./transcript-model";

type Message = ChatHistory["messages"][number];
type StoredResult = Extract<Message, { role: "tool-result" }>;
type StoredCall = NonNullable<Extract<Message, { role: "assistant" }>["toolCalls"]>[number];

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const NO_RESULT_TEXT = "No result was recorded for this call.";
const SKILL_ARGS_DELIMITER = "</skill>\n\n";

function replayUser(content: string): TranscriptEntry[] {
  if (content === "") return [];
  if (content.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return [{ kind: "notice", text: "earlier conversation compacted" }];
  }
  const skill = /^<skill name="([^"]+)"/.exec(content);
  if (!skill) return [{ kind: "user", text: content }];
  // Check the terminal close first: a body may itself contain the args delimiter.
  const delimiter = content.endsWith("</skill>") ? -1 : content.lastIndexOf(SKILL_ARGS_DELIMITER);
  const args = delimiter < 0 ? "" : content.slice(delimiter + SKILL_ARGS_DELIMITER.length).trim();
  return [{ kind: "user", text: `/${skill[1]}${args ? ` ${args}` : ""}` }];
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

function replayMessage(
  message: Message,
  results: ReadonlyMap<string, StoredResult>,
  timing: { turnId: string; timestamp: string },
): TranscriptEntry[] {
  switch (message.role) {
    case "user":
      return replayUser(message.content);
    case "assistant": {
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
