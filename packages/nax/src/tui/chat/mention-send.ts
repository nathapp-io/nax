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
import { summarizeBackgroundNotice } from "@/prompts";
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

/** The row an image the store could not read back leaves behind, named by the slot it held. */
function missingSlotLabel(number: number): string {
  return `image ${number} · missing`;
}

/**
 * The row of an image nobody can place: an older build's note, which recorded no position,
 * or a position the message's slots cannot hold.
 */
const MISSING_IMAGE_LABEL = "image · missing";

/** One unnumbered `image · missing` row per note no slot of the message can stand for. */
export function missingImageRows(count: number): readonly TranscriptEntry[] {
  return Array.from({ length: count }, () => ({ kind: "image" as const, label: MISSING_IMAGE_LABEL }));
}

/** The row one image slot draws: the image's numbered label, or the note of the number it held. */
function slotRow(position: number, image: ImageAttachment | undefined): TranscriptEntry {
  return { kind: "image", label: image === undefined ? missingSlotLabel(position) : imageNoteLabel(position, image) };
}

/**
 * One note row per image that has none of its own, in slot order. A message's slots are the
 * images it still carries plus the positions of those lost on load (`missing`), re-inserted
 * among them: the store dropped a lost image from the list without forgetting where it sat.
 *
 * The first `slots - mentioned` slots are the pasted ones; images with a row already are the
 * mentions, which a send appends last. Each pasted slot is numbered by its own slot, so a
 * lost image keeps its number instead of letting the survivors close the gap. A position the
 * slots cannot hold — more markers than slots — becomes today's unnumbered row, after the
 * numbered ones: it names an image nobody can place.
 */
function imageRows(
  images: readonly ImageAttachment[] | undefined,
  mentioned: number,
  missing: readonly number[],
): readonly TranscriptEntry[] {
  const loaded = images ?? [];
  const total = loaded.length + missing.length;
  // A position beyond the slots is a note about an image the message no longer describes.
  const lost = new Set(missing.filter((position) => position >= 1 && position <= total));
  const pasted = Math.max(0, total - mentioned);
  const rows: TranscriptEntry[] = [];
  let next = 0;
  for (let position = 1; position <= total; position += 1) {
    const here = lost.has(position);
    // Only a surviving image consumes one of `loaded`; the lost ones were dropped from it.
    const image = here ? undefined : loaded[next++];
    // A position nothing fills is a marker's claim about a slot the message lacks: no row.
    if (!here && image === undefined) continue;
    if (position <= pasted) rows.push(slotRow(position, image));
  }
  return [...rows, ...missingImageRows(missing.length - lost.size)];
}

/**
 * What one sent message becomes in the transcript: a background notice as one collapsed row,
 * a skill's invocation, the mention rows of the envelope nax expanded it into, or the message
 * as it stands, followed by one note row per image that travelled with it. `replayUser` reads
 * a stored message the same way, so a live turn and a resumed one draw alike.
 *
 * The notice row changes only the transcript: `text` is the whole notice, so the model still
 * receives every line of it. `summarizeBackgroundNotice` decides what is a notice, so text
 * that merely looks like one — `[nax-tasks] something else` — keeps today's user row. A text
 * that *does* carry pictures is never collapsed: a notice is generated, so a message with an
 * image the user attached is theirs, and swallowing the rows those images earn would leave
 * the transcript silent about a picture `host.send` still delivers.
 *
 * Each mentioned image already has its own attachment row (it is one record of the
 * envelope), and a send appends the mentions' images after the pasted ones, so only the
 * first `images.length - <image records>` images need a row. On replay the stored images are
 * short by the ones the store could not read back — it names each by the position it held —
 * so `missing` puts every lost image back at its own number.
 */
export function sentEntries(
  message: string,
  images?: readonly ImageAttachment[],
  missing: readonly number[] = [],
): readonly TranscriptEntry[] {
  if ((images?.length ?? 0) === 0 && missing.length === 0) {
    const summary = summarizeBackgroundNotice(message);
    if (summary !== undefined) return [{ kind: "background", summary, text: message }];
  }
  const skill = parseSkillInvocation(message);
  if (skill) return [{ kind: "skill", ...skill }, ...imageRows(images, 0, missing)];
  const parsed = parseMentionMessage(message);
  return [...messageEntries(message, parsed), ...imageRows(images, mentionedImageCount(parsed), missing)];
}

/** The user's own words, or the rows its envelope expanded into: nothing for empty text. */
function messageEntries(message: string, parsed: ParsedMentionMessage | undefined): readonly TranscriptEntry[] {
  if (message === "") return [];
  return parsed === undefined ? [{ kind: "user", text: message }] : mentionTranscriptEntries(parsed);
}
