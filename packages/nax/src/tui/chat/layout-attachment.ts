/**
 * Attachment rows — one transcript row per mention nax expanded on send.
 *
 * A mention sends its contents, so the transcript says what travelled: `attachmentLabel`
 * composes the one line and `attachmentLines` draws it behind the result prefix, muted, the
 * way a card's result summary is drawn. The status decides what the label claims — a file,
 * a cut file and a folder were attached, a `path-only` mention travelled as its path alone,
 * and a `refused` one did not travel at all, so its row never uses the word "attached".
 *
 * Only `attached`, `cut` and `folder` carry a body: their row ends with the expand hint and,
 * while expanded, the body follows as indented muted rows, exactly as `skillLines` draws a
 * skill's body. A `path-only` or `refused` row is its label alone and never expands —
 * `attachmentExpandable` is that rule, and the click handler asks it rather than repeating
 * the status list.
 *
 * The path is rendered with `formatMentionToken`, so a row names a path with whitespace in
 * it the same quoted way the user typed it.
 */
import { formatMentionToken, type MentionStatus } from "@/chat/mentions";
import {
  cardIndent,
  cardRows,
  HIDE_HINT,
  type LayoutContext,
  resultPrefix,
  SHOW_HINT,
  type SpanStyle,
  textLines,
} from "./layout-lines";
import type { StyledLine } from "./styled-line";
import type { TranscriptEntry } from "./transcript-model";

type AttachmentEntry = Extract<TranscriptEntry, { kind: "attachment" }>;

/** What an attachment row says it attached, before any note. */
const ATTACHED = "attached";
/** The note separator on a row that travelled whole, in part, or as a listing. */
const NOTE_SEPARATOR = " · ";
/** `path-only`, worded so the row still says the path was attached — as itself. */
const AS = " as ";
/** What separates the label from the note of a row that did not attach. */
const GAP = " ";
/** A card row is drawn in one muted tone, whatever the status. */
const MUTED: SpanStyle = { color: "muted" };
/** The statuses whose body travelled and can be revealed. */
const EXPANDABLE: ReadonlySet<MentionStatus> = new Set(["attached", "cut", "folder"]);

/** Whether ctrl+o (or a click) can reveal anything for this status. */
export function attachmentExpandable(status: MentionStatus): boolean {
  return EXPANDABLE.has(status);
}

/**
 * The row's own words: `attached @a.ts · 2 lines`, `attached @b.png as path only: binary`,
 * or `@../x not attached: outside the repo` when nothing travelled.
 */
export function attachmentLabel(entry: {
  readonly path: string;
  readonly status: MentionStatus;
  readonly note: string;
}): string {
  const path = formatMentionToken(entry.path);
  switch (entry.status) {
    case "attached":
    case "cut":
    case "folder":
      return `${ATTACHED} ${path}${NOTE_SEPARATOR}${entry.note}`;
    case "path-only":
      return `${ATTACHED} ${path}${AS}${entry.note}`;
    case "refused":
      return `${path}${GAP}${entry.note}`;
  }
}

/** The label row: the label, the expand hint while a body exists, behind the result prefix. */
function headerRows(entry: AttachmentEntry, context: LayoutContext): readonly StyledLine[] {
  const hint = context.expanded ? HIDE_HINT : SHOW_HINT;
  const label = attachmentLabel(entry);
  const text = attachmentExpandable(entry.status) ? `${label} ${hint}` : label;
  return cardRows(text, { head: resultPrefix(context.theme), rest: cardIndent(context.theme) }, MUTED, context);
}

/** The body, indented under the label the way a skill's body is, muted. */
function bodyRows(entry: AttachmentEntry, context: LayoutContext): readonly StyledLine[] {
  const indent = cardIndent(context.theme);
  return textLines(entry.body).flatMap((source) => cardRows(source, { head: indent, rest: indent }, MUTED, context));
}

/** One mention's row, expanded to its body when the entry (or the transcript) is expanded. */
export function attachmentLines(entry: AttachmentEntry, context: LayoutContext): readonly StyledLine[] {
  const header = headerRows(entry, context);
  const expanded = attachmentExpandable(entry.status) && context.expanded;
  return expanded ? [...header, ...bodyRows(entry, context)] : header;
}
