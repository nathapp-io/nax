/**
 * Image note rows — one transcript row per image that travelled with a message.
 *
 * The row is a note, not the image: `imageNoteLabel` (`@/chat/images`) already names the
 * format, the pixel size, the byte size and where the image came from, so the row is that
 * label alone, behind the result prefix and muted, exactly as an attachment row's label is
 * drawn. Nothing more is revealed by ctrl+o — the source is already in the label — so the
 * row carries no expand hint and no `open` state, which is why it is its own module rather
 * than a fourth arm of `layout-attachment.ts`.
 */
import { cardIndent, cardRows, type LayoutContext, resultPrefix, type SpanStyle } from "./layout-lines";
import type { StyledLine } from "./styled-line";
import type { TranscriptEntry } from "./transcript-model";

type ImageEntry = Extract<TranscriptEntry, { kind: "image" }>;

/** An image row is drawn in one muted tone, like every other card note. */
const MUTED: SpanStyle = { color: "muted" };

/** One image's note row: its label behind the result prefix, in the muted colour. */
export function imageLines(entry: ImageEntry, context: LayoutContext): readonly StyledLine[] {
  return cardRows(entry.label, { head: resultPrefix(context.theme), rest: cardIndent(context.theme) }, MUTED, context);
}
