/**
 * Pure opening-snapshot replay. Tool data uses the same masking and caps as live turns.
 *
 * A stored user message replays exactly as a live turn drew it — `sentEntries` is that one
 * rule — except for one thing the store did: when an image it saved could not be read back,
 * it appends a `[image missing #<n>]` line to the content instead (feature 1's load note,
 * numbered by the position the image held). Those lines are stripped from the trailing run
 * and their positions handed to `sentEntries`, so a resumed transcript draws the lost image
 * at its own number rather than renumbering the survivors. A bare `[image missing]` — a note
 * from a build that recorded no position — becomes today's unnumbered row instead.
 */
import { displayToolInput, type ImageAttachment, toolResultPreview } from "@nathapp/nax-agent";
import { COMPACTION_SUMMARY_PREFIX } from "@nathapp/nax-agent/internal";
import { acpAgentOfMessage, type ChatHistory } from "@/chat";
import { missingImageRows, sentEntries } from "./mention-send";
import type { TranscriptEntry } from "./transcript-model";

type Message = ChatHistory["messages"][number];
type StoredResult = Extract<Message, { role: "tool-result" }>;
type StoredCall = NonNullable<Extract<Message, { role: "assistant" }>["toolCalls"]>[number];

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const NO_RESULT_TEXT = "No result was recorded for this call.";
const SOURCE_LINE_BREAK = /\r\n|[\r\n]/;
/** The line feature 1's load writes in place of an image it could not read back: bare, or numbered. */
const MISSING_IMAGE_NOTE = /^\[image missing(?: #(\d+))?\]$/;

/** A stored message without its trailing note lines, and what those notes said was lost. */
interface StrippedImageNotes {
  readonly text: string;
  /** The 1-based positions of the images the store could not read back, in stored order. */
  readonly missing: readonly number[];
  /** Notes from an older build, which recorded no position for the image it lost. */
  readonly bare: number;
}

function stripMissingImageNotes(content: string): StrippedImageNotes {
  const lines = content.split(SOURCE_LINE_BREAK);
  const missing: number[] = [];
  let bare = 0;
  let end = lines.length;
  while (end > 0) {
    const note = MISSING_IMAGE_NOTE.exec(lines[end - 1]);
    if (note === null) break;
    end -= 1;
    const position = note[1];
    if (position === undefined) bare += 1;
    else missing.unshift(Number(position));
  }
  // Content with no note replays byte for byte; only a stripped one is split and rejoined.
  if (end === lines.length) return { text: content, missing: [], bare: 0 };
  return { text: lines.slice(0, end).join("\n"), missing, bare };
}

function replayUser(content: string, images: readonly ImageAttachment[] | undefined): readonly TranscriptEntry[] {
  const { text, missing, bare } = stripMissingImageNotes(content);
  if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return [{ kind: "notice", text: "earlier conversation compacted" }];
  }
  return [...sentEntries(text, images, missing), ...missingImageRows(bare)];
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
