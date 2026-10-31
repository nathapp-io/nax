/**
 * Transcript line primitives — the columns engine every entry renderer lays its text out
 * with: `layout.ts` (messages and tool cards), `layout-status.ts` (the welcome banner and
 * the status lines), `layout-listing.ts` (a titled listing) and `layout-attachment.ts` (a
 * mention's row).
 *
 * Every measurement here is in terminal columns (`displayWidth`), never in code units, so a
 * CJK message or an emoji never overflows the frame: a line wider than the layout is
 * wrapped at a word boundary with the entry's gutter kept on the continuation, and a single
 * word wider than the columns left to it is cut at that boundary — inside the word when one
 * cluster is itself wider than the line. A `width` below `MIN_LAYOUT_WIDTH` is treated as
 * that minimum, so a four-column terminal lays out exactly as a ten-column one does.
 *
 * Every text that comes from the session, a tool, an MCP server or the host passes through
 * `sanitizeText` before it becomes span text — a reply, a tool's preview or a thinking line
 * carrying `\u001b[?1049l` cannot leave the alternate screen.
 */
import { displayWidth, MIN_LAYOUT_WIDTH, type Span, type StyledLine, sanitizeText } from "./styled-line";
import type { ChatTheme } from "./theme";
import { wrapSpans } from "./wrap";

/** One entry's rendering context: the resolved width and how much detail to show. */
export interface LayoutContext {
  readonly width: number;
  readonly theme: ChatTheme;
  readonly expanded: boolean;
}

/** An empty line: what separates two entries, and what a viewport pads a short screen with. */
export const EMPTY_LINE: StyledLine = [];

/** The columns a user message and a reply take before their content starts. */
export const GUTTER_WIDTH = 2;
export const GUTTER = " ".repeat(GUTTER_WIDTH);

/** One column of space: a glyph's separator, and the gap before a thinking hint. */
export const SPACE = " ";

/** What a collapsed entry's header promises: the key that reveals its body. */
export const SHOW_HINT = "(ctrl+o to show)";
/** What an expanded entry's header promises: the key that hides its body again. */
export const HIDE_HINT = "(ctrl+o to hide)";

const TRAILING_NEWLINE = "\n";
export const SOURCE_LINE_BREAK = /\r\n|[\r\n]/;
const WHITESPACE_TOKEN = /^\s+$/;
const TOKEN_SEPARATOR = /(\s+)/;

/** Splits text into user-perceived characters, so an emoji with a skin tone stays whole. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A span's style without its text. */
export type SpanStyle = Omit<Span, "text">;

/** A width below `MIN_LAYOUT_WIDTH` (or not a number at all) is treated as the minimum. */
export function resolveWidth(width: number): number {
  const requested = Number.isFinite(width) ? Math.floor(width) : MIN_LAYOUT_WIDTH;
  return Math.max(requested, MIN_LAYOUT_WIDTH);
}

function graphemes(text: string): readonly string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (segment) => segment.segment);
}

export function styled(text: string, style: SpanStyle = {}): Span {
  return { text, ...style };
}

/** A line from spans, dropping the empty ones so a line never carries a blank span. */
export function line(spans: readonly Span[]): StyledLine {
  return spans.filter((span) => span.text !== "");
}

/** A line's width in terminal columns. */
export function lineWidth(spans: readonly Span[]): number {
  return spans.reduce((total, span) => total + displayWidth(span.text), 0);
}

/**
 * The text's lines: sanitised, with the line break that ends a file's last line taken off.
 * An **empty** text has no lines; a text that is only that line break — `"\n"`, or one that
 * is left as `""` after it is taken off — is one blank source line, which the layout keeps.
 */
export function textLines(text: string): readonly string[] {
  const body = sanitizeText(text);
  if (body === "") return [];
  const trimmed = body.endsWith(TRAILING_NEWLINE) ? body.slice(0, -TRAILING_NEWLINE.length) : body;
  return trimmed.split(SOURCE_LINE_BREAK);
}

/** Split one cluster wider than a whole line into pieces, cutting between code points. */
function cutCluster(cluster: string, columns: number): readonly string[] {
  const pieces: string[] = [];
  let current = "";
  let used = 0;
  for (const point of cluster) {
    const width = displayWidth(point);
    if (current !== "" && used + width > columns) {
      pieces.push(current);
      current = "";
      used = 0;
    }
    current += point;
    used += width;
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

/**
 * Cut one over-wide word into pieces no wider than `columns`. A cluster wider than the
 * whole line — an Indic conjunct can be one grapheme many columns wide — cannot fit
 * anywhere, so it is cut between code points: keeping the line inside the width wins over
 * keeping the cluster whole, exactly as `renderMarkdown` resolves the same case.
 */
function cutWord(word: string, columns: number): readonly string[] {
  const limit = Math.max(1, columns);
  const pieces: string[] = [];
  let current = "";
  let used = 0;
  const flush = () => {
    if (current !== "") pieces.push(current);
    current = "";
    used = 0;
  };
  for (const glyph of graphemes(word)) {
    const width = displayWidth(glyph);
    if (width > limit) {
      flush();
      pieces.push(...cutCluster(glyph, limit));
      continue;
    }
    if (used + width > limit) flush();
    current += glyph;
    used += width;
  }
  flush();
  return pieces;
}

/**
 * Greedy word wrap over display columns. A word that does not fit opens a new line and
 * takes the spaces before it with it, the spaces *between* words on one line are kept as
 * they arrived, and a single word wider than the line is cut at the line's width so no
 * line overflows.
 */
export function wrapText(text: string, columns: number): readonly string[] {
  const limit = Math.max(1, columns);
  const lines: string[] = [];
  let current = "";
  let used = 0;
  /** The spaces before the next word: kept when that word fits here, dropped when it does not. */
  let pending = "";
  let pendingWidth = 0;
  const flush = () => {
    if (current !== "") lines.push(current);
    current = "";
    used = 0;
    pending = "";
    pendingWidth = 0;
  };
  for (const token of text.split(TOKEN_SEPARATOR)) {
    if (token === "") continue;
    if (WHITESPACE_TOKEN.test(token)) {
      // A line never starts with the spaces of a wrap point, so they are held, not written.
      if (current !== "") {
        pending = token;
        pendingWidth = displayWidth(token);
      }
      continue;
    }
    const tokenWidth = displayWidth(token);
    if (used + pendingWidth + tokenWidth <= limit) {
      current += pending + token;
      used += pendingWidth + tokenWidth;
      pending = "";
      pendingWidth = 0;
      continue;
    }
    flush();
    const pieces = cutWord(token, limit);
    pieces.forEach((piece, index) => {
      current = piece;
      used = displayWidth(piece);
      if (index < pieces.length - 1) flush();
    });
  }
  flush();
  return lines;
}

/**
 * A source line's wrapped content. A blank or whitespace-only source line is one blank
 * line — it is the message's own formatting, not a wrap point — so it survives as one.
 */
export function wrappedSource(text: string, columns: number): readonly string[] {
  const pieces = wrapText(text, columns);
  return pieces.length === 0 ? [""] : pieces;
}

/**
 * One line behind its prefix. A line that fits is drawn whole; a wider one is wrapped at
 * word boundaries with blank columns as wide as the prefix on every continuation, so a
 * narrow layout loses neither a card's output nor a reply's words.
 */
export function prefixedLine(
  spans: readonly Span[],
  prefix: readonly Span[],
  context: LayoutContext,
): readonly StyledLine[] {
  const prefixed = line([...prefix, ...spans]);
  if (lineWidth(prefixed) <= context.width) return [prefixed];
  return wrapSpans(spans, { width: context.width, prefix });
}

/** A text flattened to one row: a header, a glyph line or a diff line is one row by definition. */
export function oneLine(text: string): string {
  return text.split(SOURCE_LINE_BREAK).join(SPACE);
}

/** `  ⎿  ` — the gutter, the result glyph, and the two columns that follow it. */
export function resultPrefix(theme: ChatTheme): string {
  return `${GUTTER}${theme.glyphs.result}${SPACE}${SPACE}`;
}

/** Where a card's later summary lines, its diff lines and its expand hint start. */
export function cardIndent(theme: ChatTheme): string {
  return SPACE.repeat(displayWidth(resultPrefix(theme)));
}

/**
 * One card line's rows: its text split at its own line breaks, the first physical line
 * behind `head` and every later one behind `rest`. A summary that interpolates a path
 * carrying a newline would otherwise draw a terminal row with no card indent at all, which
 * the row-based viewport would count as nothing.
 */
export function cardRows(
  text: string,
  prefixes: { readonly head: string; readonly rest: string },
  style: SpanStyle,
  context: LayoutContext,
): readonly StyledLine[] {
  return sanitizeText(text)
    .split(SOURCE_LINE_BREAK)
    .flatMap((physical, index) =>
      prefixedLine([styled(physical, style)], [styled(index === 0 ? prefixes.head : prefixes.rest, style)], context),
    );
}
