/**
 * Background notice rows — one transcript row for a notice `useJobs` delivered.
 *
 * A notice reaches `sendTurn({ message })` and travels to the model whole, so the transcript
 * has no user words to draw: `summarizeBackgroundNotice` names what ended and this module
 * draws that name behind the result prefix, muted, the way a card's result summary is drawn.
 * Collapsed, the row promises the notice with the expand hint; opened, every notice line
 * follows as an indented muted row — the buffer `nax-tasks__output` and the job log still
 * hold, should the reader want it whole.
 *
 * Nothing here decides what is a notice: `sentEntries` asks the summary for that, so text
 * that merely looks like a notice keeps today's user row.
 */
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

type BackgroundEntry = Extract<TranscriptEntry, { kind: "background" }>;

/** A notice row is drawn in one muted tone, whole. */
const MUTED: SpanStyle = { color: "muted" };

/** The summary row: what ended, and the hint naming the key that reveals the notice. */
function summaryRows(entry: BackgroundEntry, context: LayoutContext): readonly StyledLine[] {
  const hint = context.expanded ? HIDE_HINT : SHOW_HINT;
  const label = `${entry.summary} ${hint}`;
  return cardRows(label, { head: resultPrefix(context.theme), rest: cardIndent(context.theme) }, MUTED, context);
}

/** The notice itself, indented under the summary the way a skill's body is, muted. */
function noticeRows(entry: BackgroundEntry, context: LayoutContext): readonly StyledLine[] {
  const indent = cardIndent(context.theme);
  return textLines(entry.text).flatMap((source) => cardRows(source, { head: indent, rest: indent }, MUTED, context));
}

/** One background notice: its summary row, and while expanded the notice's own lines. */
export function backgroundLines(entry: BackgroundEntry, context: LayoutContext): readonly StyledLine[] {
  const summary = summaryRows(entry, context);
  return context.expanded ? [...summary, ...noticeRows(entry, context)] : summary;
}
