/**
 * The turns an opening ACP agent has not seen, as speaker/text entries.
 *
 * A chat session's native document is shared by every brain. When the ACP
 * branch opens an agent, that agent already holds the turns it wrote itself
 * (its own session replays them), so only what follows its last recorded turn
 * is new to it. These pure functions pick that suffix out and flatten it into
 * the capped speaker/text entries a handoff prompt is rendered from.
 *
 * Pure: no I/O, no config, no clock. The total 40,000-character bound and the
 * prompt itself belong to the caller (US-003).
 */
import type { ImageAttachment } from "@nathapp/nax-agent";
import { imageFormatOf } from "../images";
import { acpAgentOfMessage, type ChatMessage } from "./acp-history";
import type { AcpChatAgent } from "./acp-model";
import { acpAgentLabel } from "./acp-model";

/** UTF-16 code units of one entry's text, before the ellipsis that marks a cut. */
export const ACP_HANDOFF_ENTRY_MAX_CHARS = 4_000;

export interface HandoffEntry {
  readonly speaker: string;
  readonly text: string;
}

const ACP_ORIGIN_PREFIX = "acp:";
const USER_SPEAKER = "User";
const NATIVE_SPEAKER = "nax";
const TOOL_LINE_PREFIX = "[tool] ";
const LINE_SEPARATOR = "\n";
const ELLIPSIS = "…";
const IMAGE_NOTE_OPEN = "[image ";
const IMAGE_NOTE_CLOSE = "; not carried across the switch]";
/** U+00D7, the multiplication sign the transcript labels use between width and height. */
const PIXEL_SEPARATOR = "×";

/**
 * The messages an opening agent has not seen: all of them for a fresh agent
 * session, otherwise everything after the last assistant message the agent
 * wrote itself. An agent with no such message (a session from before this
 * feature) is handed the whole history.
 */
export function unseenMessages(
  messages: readonly ChatMessage[],
  agent: AcpChatAgent,
  fresh: boolean,
): readonly ChatMessage[] {
  if (fresh) return messages;
  const lastOwnTurn = messages.findLastIndex((message) => acpAgentOfMessage(message) === agent);
  return lastOwnTurn === -1 ? messages : messages.slice(lastOwnTurn + 1);
}

/** `nax` for a native turn, `nax (<model>)` for another provider, the agent's label for a chat agent. */
function assistantSpeaker(message: Extract<ChatMessage, { readonly role: "assistant" }>): string {
  const origin = message.origin;
  if (origin === undefined) return NATIVE_SPEAKER;
  if (!origin.provider.startsWith(ACP_ORIGIN_PREFIX)) return `${NATIVE_SPEAKER} (${origin.model})`;
  const agent = acpAgentOfMessage(message);
  return agent === undefined ? origin.provider : acpAgentLabel(agent);
}

/** The content, then one `[tool] <name>` line per call; no leading newline when there is no content. */
function assistantText(message: Extract<ChatMessage, { readonly role: "assistant" }>): string {
  const toolLines = (message.toolCalls ?? []).map((call) => `${TOOL_LINE_PREFIX}${call.name}`);
  return [...(message.content === "" ? [] : [message.content]), ...toolLines].join(LINE_SEPARATOR);
}

/** The pixel size, only when the image carries both dimensions. */
function pixelsOf(image: ImageAttachment): string {
  const { width, height } = image;
  if (width === undefined || height === undefined) return "";
  return ` ${width}${PIXEL_SEPARATOR}${height}`;
}

/** `[image <n>: <format> <w>×<h>, <source>; not carried across the switch]`, the optional parts omitted. */
function imageNote(number: number, image: ImageAttachment): string {
  const source = image.source === undefined ? "" : `, ${image.source}`;
  const body = `${imageFormatOf(image.mimeType)}${pixelsOf(image)}${source}`;
  return `${IMAGE_NOTE_OPEN}${number}: ${body}${IMAGE_NOTE_CLOSE}`;
}

/**
 * The content, then one note line per image in order; no leading newline when there is no
 * content. The note is all the next brain gets: earlier images are not re-sent across a switch.
 */
function userText(message: Extract<ChatMessage, { readonly role: "user" }>): string {
  const notes = (message.images ?? []).map((image, index) => imageNote(index + 1, image));
  return [...(message.content === "" ? [] : [message.content]), ...notes].join(LINE_SEPARATOR);
}

/** An entry's text is cut to its first `ACP_HANDOFF_ENTRY_MAX_CHARS` UTF-16 units, then marked. */
function capped(text: string): string {
  return text.length > ACP_HANDOFF_ENTRY_MAX_CHARS ? `${text.slice(0, ACP_HANDOFF_ENTRY_MAX_CHARS)}${ELLIPSIS}` : text;
}

function entryOf(message: ChatMessage): HandoffEntry | undefined {
  if (message.role === "user") return { speaker: USER_SPEAKER, text: capped(userText(message)) };
  if (message.role !== "assistant") return undefined;
  const text = assistantText(message);
  if (text === "") return undefined;
  return { speaker: assistantSpeaker(message), text: capped(text) };
}

/**
 * One entry per user and per assistant message, each text cut to the entry cap.
 * Tool-result messages and assistant messages with neither text nor tool calls
 * are dropped; thinking is ignored. No total bound is applied here.
 */
export function handoffEntries(messages: readonly ChatMessage[]): readonly HandoffEntry[] {
  const entries: HandoffEntry[] = [];
  for (const message of messages) {
    const entry = entryOf(message);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}
