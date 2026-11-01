/**
 * Mention handling on the send path — what a typed chat message costs on the way out, and
 * what it becomes in the transcript once its mentions are attached.
 *
 * nax expands mentions here, in the TUI's prepare step, once per send: every brain (native,
 * Claude Code, Codex, Cursor) receives the same string and the session store saves it, so no
 * brain, store or protocol knows about mentions at all. The expander itself is the screen's
 * seam (`_chatAppDeps.expandMentions`), passed in rather than imported, so a test drives this
 * module without a filesystem.
 *
 * The message a brain receives carries the typed text plus a record per mention
 * (`ParsedMentionMessage`); `sentEntries` turns that envelope into the user's own words with
 * the paths that travelled, followed by one attachment row per record and one note row per
 * image the message carried.
 */
import type { ImageAttachment } from "@nathapp/nax-agent";
import {
  type ExpandedMentions,
  imageNoteLabel,
  type MentionWhere,
  type ParsedMentionMessage,
  parseMentionMessage,
  parseSkillInvocation,
} from "@/chat";
import { mentionTranscriptEntries } from "./mention-entries";
import type { TranscriptEntry } from "./transcript-model";

/** What attaching a message's mentions costs: the typed text and where the user is, in and out. */
export type MentionExpander = (text: string, where: MentionWhere) => Promise<ExpandedMentions>;

/**
 * What a typed message must carry to be worth expanding: a mention token's `@`, or the
 * trailer of an expanded message pasted back in (which `formatMentionMessage` re-parses). A
 * message with neither keeps today's exact send, so nothing else pays for the expansion.
 */
const MENTION_TRIGGERS: readonly string[] = ["@", "</nax-mentions"];

/** Whether a typed message carries anything for the expander to resolve. */
export function needsMentionExpansion(text: string): boolean {
  return MENTION_TRIGGERS.some((trigger) => text.includes(trigger));
}

/**
 * The `sendTurn` prepare step for one typed message: it expands the text once, against the
 * cwd and repo root, and resolves the string the brain receives. Undefined when the message
 * has nothing to expand — the caller then keeps the plain send, and the typed text is both
 * the send's title and the draft history's entry.
 */
export function mentionPrepare(
  text: string,
  where: MentionWhere,
  expand: MentionExpander,
): (() => Promise<{ message: string }>) | undefined {
  if (!needsMentionExpansion(text)) return undefined;
  return async () => {
    const expanded = await expand(text, where);
    return { message: expanded.message };
  };
}

/**
 * How many of a message's images already have an attachment row: a mentioned image is one
 * `image` record of the envelope nax expanded the message into. No envelope, or one that
 * carried no image, means every image was pasted and needs its own note row.
 */
function mentionedImageCount(parsed: ParsedMentionMessage | undefined): number {
  return parsed === undefined ? 0 : parsed.records.filter((record) => record.status === "image").length;
}

/**
 * One note row per image that has none of its own: the first `images.length - mentioned` of
 * them, numbered from one in the order they were sent. Images with a row already are the
 * mentions, which a send appends last, so the pasted ones are the leading run.
 */
function imageRows(images: readonly ImageAttachment[] | undefined, mentioned: number): readonly TranscriptEntry[] {
  const sent = images ?? [];
  const pasted = sent.slice(0, Math.max(0, sent.length - mentioned));
  return pasted.map((image, index) => ({ kind: "image", label: imageNoteLabel(index + 1, image) }));
}

/**
 * What one sent message becomes in the transcript: a skill's invocation, the mention rows of
 * the envelope nax expanded it into, or the message as it stands, followed by one note row
 * per image that travelled with it. `replayUser` reads a stored message the same way, so a
 * live turn and a resumed one draw alike.
 *
 * Each mentioned image already has its own attachment row (it is one record of the
 * envelope), and a send appends the mentions' images after the pasted ones, so only the
 * first `images.length - <image records>` images need a row. On replay the stored images can
 * be one short of what was sent — one was dropped as missing — and that count simply covers
 * one fewer row; the `image · missing` row `replayUser` adds says what happened to it.
 */
export function sentEntries(message: string, images?: readonly ImageAttachment[]): readonly TranscriptEntry[] {
  const skill = parseSkillInvocation(message);
  if (skill) return [{ kind: "skill", ...skill }, ...imageRows(images, 0)];
  const parsed = parseMentionMessage(message);
  const entries = parsed === undefined ? [{ kind: "user" as const, text: message }] : mentionTranscriptEntries(parsed);
  return [...entries, ...imageRows(images, mentionedImageCount(parsed))];
}
