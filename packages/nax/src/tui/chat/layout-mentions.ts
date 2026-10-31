/**
 * User-message mention spans — the accent highlight over each `@path` a message listed.
 *
 * A sent message is drawn as the text the user typed, and every mention the message carried
 * is picked out of it in the marker's own colour, so the transcript shows at a glance what
 * travelled. The comparison is textual and deliberately looser than the grammar that read
 * the message on send: a mention sits wherever its token appears, whatever precedes it, so
 * `see (@a.ts).` highlights `@a.ts` even though the send-side grammar only starts a token
 * after whitespace.
 *
 * A token that is only part of a longer path is not an occurrence (`@a.ts` inside
 * `@a.tsx`), but trailing `.,;:!?)` characters — the punctuation prose puts after a path —
 * do not disqualify one when whitespace or the end of the line follows them. The rule is
 * applied to the source line, and a row is styled from the source offsets the wrap gave it,
 * so an occurrence a hard wrap cut in two is drawn plain in both halves while every whole
 * occurrence on a row is highlighted.
 */
import { formatMentionToken } from "@/chat/mentions";
import { styled, textLines, wrappedSource } from "./layout-lines";
import type { Span } from "./styled-line";

/** What may trail a mention, as long as whitespace or the end of the text follows the run. */
const TRAILING_PUNCTUATION = ".,;:!?)";
const WHITESPACE = /\s/;
/** How a mention is coloured: the marker's accent, so the message still reads as one. */
const MENTION_COLOR = "accent";

/** One occurrence of a listed mention's token, as offsets into the source line. */
interface MentionRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Whether the token ending at `end` is a whole occurrence: the character that follows it is
 * whitespace, the end of the text, or a run of trailing punctuation that ends in one of the
 * two. A path that simply continues (`@a.ts` in `@a.tsx`) is not an occurrence.
 */
function endsMention(text: string, end: number): boolean {
  let index = end;
  while (index < text.length && TRAILING_PUNCTUATION.includes(text.charAt(index))) index += 1;
  const next = text.charAt(index);
  return next === "" || WHITESPACE.test(next);
}

/** Every whole occurrence of every listed path in one source line, in source order. */
function mentionRanges(text: string, mentions: readonly string[]): readonly MentionRange[] {
  const ranges: MentionRange[] = [];
  for (const path of mentions) {
    if (path === "") continue;
    const token = formatMentionToken(path);
    let from = 0;
    let start = text.indexOf(token, from);
    while (start >= 0) {
      const end = start + token.length;
      if (endsMention(text, end)) ranges.push({ start, end });
      from = end;
      start = text.indexOf(token, from);
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

/**
 * Each wrapped piece's offset in the source line it came from. A wrap never starts a piece
 * with the whitespace it broke at, so searching from where the previous piece ended finds
 * the piece's own start — and a cut piece starts exactly where the last one stopped.
 */
function pieceOffsets(source: string, pieces: readonly string[]): readonly number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const found = piece === "" ? cursor : source.indexOf(piece, cursor);
    const start = found < 0 ? cursor : found;
    offsets.push(start);
    cursor = start + piece.length;
  }
  return offsets;
}

/** One row's spans: its text in plain runs, with every occurrence wholly inside it accent. */
function rowSpans(content: string, from: number, ranges: readonly MentionRange[]): readonly Span[] {
  const to = from + content.length;
  const spans: Span[] = [];
  let cursor = from;
  for (const range of ranges) {
    if (range.start < cursor || range.end > to) continue;
    if (range.start > cursor) spans.push(styled(content.slice(cursor - from, range.start - from)));
    spans.push(styled(content.slice(range.start - from, range.end - from), { color: MENTION_COLOR }));
    cursor = range.end;
  }
  if (cursor < to) spans.push(styled(content.slice(cursor - from)));
  return spans;
}

/**
 * A user message's rows as spans, `columns` wide: the text wrapped exactly as the message is
 * always wrapped, with each listed mention's whole occurrences coloured. The caller adds the
 * marker, the gutter and the band — this function colours the words and nothing else.
 */
export function userTextSpans(
  text: string,
  mentions: readonly string[],
  columns: number,
): readonly (readonly Span[])[] {
  const rows: (readonly Span[])[] = [];
  for (const source of textLines(text)) {
    const ranges = mentions.length === 0 ? [] : mentionRanges(source, mentions);
    const pieces = wrappedSource(source, columns);
    const offsets = pieceOffsets(source, pieces);
    pieces.forEach((piece, index) => {
      rows.push(rowSpans(piece, offsets[index], ranges));
    });
  }
  return rows;
}
