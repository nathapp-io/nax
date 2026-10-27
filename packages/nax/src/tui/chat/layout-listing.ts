/**
 * A titled listing — the block a slash command shows where a reply would go: a bold title
 * and then its text lines, each coloured by what it reports. `/mcp` is the first user of it
 * (`formatMcpListing` writes the lines), and `/help`, `/skills` and `/plugins` follow.
 *
 * `listingTone` is the whole colour rule, checked in this order: a line that reports
 * something is **not locked** or **not connected** is a `warning`; a line that says it
 * **failed** is `danger`; a line that is `connected` is `success`; anything else is `plain`
 * and keeps the terminal's own colour. The order is the rule rather than an implementation
 * detail — "not connected" contains "connected", and a missing lock is *why* a server is
 * down, so the warning has to win over the success it would otherwise read as.
 *
 * A line wider than the layout wraps at a word boundary, its continuation starting in the
 * listing's own column (the title's), and a blank line of the text is kept as a blank row —
 * it is the listing's formatting, not a wrap point. Every string passes through
 * `sanitizeText` (inside `textLines`) before it becomes span text, and the title carries no
 * row of its own beyond the first: a break in it is flattened like a card's title.
 */
import {
  type LayoutContext,
  line,
  oneLine,
  prefixedLine,
  type SpanStyle,
  styled,
  textLines,
  wrappedSource,
} from "./layout-lines";
import { type StyledLine, sanitizeText } from "./styled-line";
import type { TranscriptEntry } from "./transcript-model";

type ListingEntry = Extract<TranscriptEntry, { kind: "listing" }>;

/** What one listing line reports; `plain` keeps the terminal's own colour. */
export type ListingTone = "warning" | "danger" | "success" | "plain";

/** A line naming a server that is not locked or not connected is a warning, first of all. */
const WARNING_MARKERS = ["not locked", "not connected"] as const;
/** A line reporting that something failed is an error. */
const DANGER_MARKER = "failed";
/** A line reporting that something is up is a success. */
const SUCCESS_MARKER = "connected";

/**
 * The tone of one listing line, from the ordered checks above. It reads the text the host
 * wrote, not the colours the theme can draw: a colourless terminal still gets the tone, and
 * the view decides what to do with it.
 */
export function listingTone(text: string): ListingTone {
  if (WARNING_MARKERS.some((marker) => text.includes(marker))) return "warning";
  if (text.includes(DANGER_MARKER)) return "danger";
  if (text.includes(SUCCESS_MARKER)) return "success";
  return "plain";
}

/** The style a tone draws with: a plain line is drawn exactly as the terminal's own text. */
function toneStyle(tone: ListingTone): SpanStyle {
  return tone === "plain" ? {} : { color: tone };
}

/** One source line of the listing, coloured by its tone, wrapped at the layout's width. */
function textRows(source: string, context: LayoutContext): readonly StyledLine[] {
  const style = toneStyle(listingTone(source));
  return wrappedSource(source, context.width).map((piece) => line([styled(piece, style)]));
}

/**
 * A listing: the title in bold, then every text line in order, each in the colour its tone
 * asks for. A listing with no text is its title alone, and a line too wide for the layout
 * wraps rather than overflowing it.
 */
export function listingLines(entry: ListingEntry, context: LayoutContext): readonly StyledLine[] {
  const title = prefixedLine([styled(oneLine(sanitizeText(entry.title)), { bold: true })], [], context);
  return [...title, ...textLines(entry.text).flatMap((source) => textRows(source, context))];
}
