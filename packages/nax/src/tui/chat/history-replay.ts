/**
 * Pure opening-snapshot replay. Tool data uses the same masking and caps as live turns.
 *
 * A stored user message replays exactly as a live turn drew it — `sentEntries` is that one
 * rule — except for one thing the store did: when an image it saved could not be read back,
 * it appends a `[image missing]` line to the content instead (feature 1's load note). Those
 * lines are stripped from the trailing run and each becomes an `image · missing` row, so a
 * resumed transcript says an image was sent and is gone rather than showing the note as if
 * the user had typed it.
 */
import { displayToolInput, type ImageAttachment, toolResultPreview } from "@nathapp/nax-agent";
import { COMPACTION_SUMMARY_PREFIX } from "@nathapp/nax-agent/internal";
import { acpAgentOfMessage, type ChatHistory } from "@/chat";
import { sentEntries } from "./mention-send";
import type { TranscriptEntry } from "./transcript-model";

type Message = ChatHistory["messages"][number];
type StoredResult = Extract<Message, { role: "tool-result" }>;
type StoredCall = NonNullable<Extract<Message, { role: "assistant" }>["toolCalls"]>[number];

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const NO_RESULT_TEXT = "No result was recorded for this call.";
const SOURCE_LINE_BREAK = /\r\n|[\r\n]/;
/** The line feature 1's load writes in place of an image it could not read back. */
const MISSING_IMAGE_NOTE = "[image missing]";
/** What a stripped note becomes: a row saying the image the message named is gone. */
const MISSING_IMAGE_LABEL = "image · missing";

/** A stored message without its trailing `[image missing]` lines, and how many were taken. */
interface StrippedImageNotes {
  readonly text: string;
  readonly missing: number;
}

function stripMissingImageNotes(content: string): StrippedImageNotes {
  const lines = content.split(SOURCE_LINE_BREAK);
  let end = lines.length;
  while (end > 0 && lines[end - 1] === MISSING_IMAGE_NOTE) end -= 1;
  // Content with no note replays byte for byte; only a stripped one is split and rejoined.
  if (end === lines.length) return { text: content, missing: 0 };
  return { text: lines.slice(0, end).join("\n"), missing: lines.length - end };
}

function missingImageRows(count: number): readonly TranscriptEntry[] {
  return Array.from({ length: count }, () => ({ kind: "image", label: MISSING_IMAGE_LABEL }));
}

function replayUser(content: string, images: readonly ImageAttachment[] | undefined): readonly TranscriptEntry[] {
  const { text, missing } = stripMissingImageNotes(content);
  const stripped = missingImageRows(missing);
  if (text === "") return stripped;
  if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return [{ kind: "notice", text: "earlier conversation compacted" }];
  }
  return [...sentEntries(text, images), ...stripped];
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
): readonly TranscriptEntry[] {
  switch (message.role) {
    case "user":
      return replayUser(message.content, message.images);
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
