/**
 * Transcript layout — `layoutTranscript` turns the entry union into the styled lines the
 * chat view draws: each entry's own lines, with one empty line between the entries that
 * produced any.
 *
 * Every decision here is a measurement in terminal columns (`displayWidth`), never in
 * code units, so a CJK message or an emoji never overflows the frame: a line wider than
 * the layout is wrapped at a word boundary with the entry's gutter kept on the
 * continuation, and a single word wider than the columns left to it is cut at that
 * boundary — inside the word when one cluster is itself wider than the line. A `width`
 * below `MIN_LAYOUT_WIDTH` is treated as that minimum, so a four-column terminal lays out
 * exactly as a ten-column one does.
 *
 * A reply is rendered into the columns left behind its gutter, and the one line
 * `renderMarkdown` leaves wide on purpose — a fenced block's code line — is cut at the
 * layout's width (wrapping would invent line numbers the code's own indentation
 * contradicts). Every other line it leaves wide, a table's source text or raw HTML, is
 * wrapped instead, so a narrow layout never loses a reply's words.
 *
 * Every text that comes from the session, a tool, an MCP server or the host passes
 * through `sanitizeText` before it becomes span text — a reply or a thinking line
 * carrying `\u001b[?1049l` cannot leave the alternate screen.
 *
 * The dispatcher covers the whole `TranscriptEntry` union; the welcome, tool, notice,
 * warning, error, listing and interrupted cases are filled in by US-010 and US-011.
 */
import { renderMarkdown, wrapSpans } from "./markdown";
import { displayWidth, MIN_LAYOUT_WIDTH, type Span, type StyledLine, sanitizeText } from "./styled-line";
import type { ChatTheme } from "./theme";
import { secondsBetween } from "./tool-card";
import type { TranscriptEntry } from "./transcript-model";

export interface LayoutOptions {
  /** The columns available to the transcript; below `MIN_LAYOUT_WIDTH` is treated as it. */
  readonly width: number;
  readonly theme: ChatTheme;
  /** Whether collapsed detail — thinking text, tool output — is shown. */
  readonly expanded: boolean;
}

type UserEntry = Extract<TranscriptEntry, { kind: "user" }>;
type ReplyEntry = Extract<TranscriptEntry, { kind: "reply" }>;
type ThinkingEntry = Extract<TranscriptEntry, { kind: "thinking" }>;

/** One entry's rendering context: the resolved width and how much detail to show. */
interface LayoutContext {
  readonly width: number;
  readonly theme: ChatTheme;
  readonly expanded: boolean;
}

/** An empty line: what separates two entries, and what a viewport pads a short screen with. */
export const EMPTY_LINE: StyledLine = [];

/** The columns a user message and a reply take before their content starts. */
const GUTTER_WIDTH = 2;
const GUTTER = " ".repeat(GUTTER_WIDTH);
/**
 * The narrowest width a reply's markdown is rendered into. It is the layout's floor minus
 * the gutter, and is passed as `minWidth` so the renderer respects a content budget that
 * is legitimately narrower than a whole layout.
 */
const MIN_REPLY_WIDTH = MIN_LAYOUT_WIDTH - GUTTER_WIDTH;
/** The marker that opens a user message; it is its own span so a view can colour it. */
const USER_MARKER = ">";
const USER_BAND = "userBand";
const THOUGHT_FOR = "Thought for";
const SHOW_HINT = "(ctrl+o to show)";
const HIDE_HINT = "(ctrl+o to hide)";
const SECONDS_SUFFIX = "s";
/** One column of space: a marker's separator, and the gap before a thinking hint. */
const SPACE = " ";
const TRAILING_NEWLINE = "\n";
const SOURCE_LINE_BREAK = /\r\n|[\r\n]/;
const WHITESPACE_TOKEN = /^\s+$/;
const TOKEN_SEPARATOR = /(\s+)/;

/** Splits text into user-perceived characters, so an emoji with a skin tone stays whole. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A width below `MIN_LAYOUT_WIDTH` (or not a number at all) is treated as the minimum. */
function resolveWidth(width: number): number {
  const requested = Number.isFinite(width) ? Math.floor(width) : MIN_LAYOUT_WIDTH;
  return Math.max(requested, MIN_LAYOUT_WIDTH);
}

function graphemes(text: string): readonly string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (segment) => segment.segment);
}

/** A span's style without its text. */
type SpanStyle = Omit<Span, "text">;

function styled(text: string, style: SpanStyle = {}): Span {
  return { text, ...style };
}

/** A line from spans, dropping the empty ones so a line never carries a blank span. */
function line(spans: readonly Span[]): StyledLine {
  return spans.filter((span) => span.text !== "");
}

/** A line's width in terminal columns. */
function lineWidth(spans: readonly Span[]): number {
  return spans.reduce((total, span) => total + displayWidth(span.text), 0);
}

/** The text's lines: sanitised, with the line break that ends a file's last line taken off. */
function textLines(text: string): readonly string[] {
  const body = sanitizeText(text);
  const trimmed = body.endsWith(TRAILING_NEWLINE) ? body.slice(0, -TRAILING_NEWLINE.length) : body;
  return trimmed === "" ? [] : trimmed.split(SOURCE_LINE_BREAK);
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
function wrapText(text: string, columns: number): readonly string[] {
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

/** Keep at most `columns` columns of `spans`, dropping whole clusters from the right. */
function cutLine(spans: readonly Span[], columns: number): StyledLine {
  if (lineWidth(spans) <= columns) return line(spans);
  const kept: Span[] = [];
  let used = 0;
  let full = false;
  for (const span of spans) {
    let text = "";
    for (const glyph of graphemes(span.text)) {
      const width = displayWidth(glyph);
      if (used + width > columns) {
        // Nothing after the cut is drawn: the next span's text is not this line's tail.
        full = true;
        break;
      }
      text += glyph;
      used += width;
    }
    if (text !== "") kept.push({ ...span, text });
    if (full) break;
  }
  return line(kept);
}

/** Muted italics: how the layout draws anything the model thought rather than said. */
function thoughtLine(text: string): StyledLine {
  return line([{ text, color: "muted", italic: true }]);
}

/**
 * A source line's wrapped content. A blank or whitespace-only source line is one blank
 * line — it is the message's own formatting, not a wrap point — so it survives as one.
 */
function wrappedSource(text: string, columns: number): readonly string[] {
  const pieces = wrapText(text, columns);
  return pieces.length === 0 ? [""] : pieces;
}

/**
 * A user message: every source line behind the accent marker (its continuations, and
 * every later source line, behind two spaces), banded `userBand` across the whole width.
 * A blank source line stays a blank indented line, so a two-paragraph message keeps its
 * break.
 */
function userLines(entry: UserEntry, context: LayoutContext): readonly StyledLine[] {
  const marker = styled(USER_MARKER, { color: "accent", background: USER_BAND });
  const gutter = styled(GUTTER, { background: USER_BAND });
  const lines: StyledLine[] = [];
  for (const source of textLines(entry.text)) {
    for (const content of wrappedSource(source, context.width - GUTTER_WIDTH)) {
      // The marker carries its own trailing space; every other line's gutter is the two
      // spaces themselves, so the content starts at the same column either way. A blank
      // line is drawn as its gutter alone, never with a trailing space.
      const [prefix, text] = lines.length === 0 ? [marker, content === "" ? "" : SPACE + content] : [gutter, content];
      lines.push(line([prefix, styled(text, { background: USER_BAND })]));
    }
  }
  return lines;
}

/** A line `renderMarkdown` leaves wide on purpose: a fenced block's body, drawn after the codeSide glyph. */
function isCodeLine(spans: readonly Span[], theme: ChatTheme): boolean {
  const [first] = spans;
  return first !== undefined && first.color === "muted" && first.text === `${theme.glyphs.codeSide} `;
}

/** One rendered reply line behind its gutter, wrapped when the renderer left it too wide. */
function replyLine(spans: StyledLine, prefix: Span, context: LayoutContext): readonly StyledLine[] {
  const prefixed = line([prefix, ...spans]);
  if (lineWidth(prefixed) <= context.width) return [prefixed];
  // A code line is the one line markdown never wraps, and the layout cuts it at the width
  // (US-008). Anything else it left wide — a table's source text, raw HTML — is prose:
  // wrap it rather than lose it.
  if (isCodeLine(spans, context.theme)) return [cutLine(prefixed, context.width)];
  return wrapSpans(spans, { width: context.width, prefix: [prefix] });
}

/**
 * A reply: its markdown rendered into the columns left behind the gutter, the first line
 * behind the bullet glyph and the rest behind two spaces. A line the renderer left wide is
 * cut only when it is a code line; every other one is wrapped, so no reply loses words.
 */
function replyLines(entry: ReplyEntry, context: LayoutContext): readonly StyledLine[] {
  const rendered = renderMarkdown(entry.text, {
    width: context.width - GUTTER_WIDTH,
    theme: context.theme,
    minWidth: MIN_REPLY_WIDTH,
  });
  const marker = styled(`${context.theme.glyphs.bullet}${SPACE}`);
  const gutter = styled(GUTTER);
  return rendered.flatMap((spans, index) => replyLine(spans, index === 0 ? marker : gutter, context));
}

/** `✻ Thought for 6s (ctrl+o to show)` — how a finished thinking block describes itself. */
function thoughtHeader(entry: ThinkingEntry, context: LayoutContext): readonly StyledLine[] {
  const seconds = secondsBetween(entry.startedAt, entry.endedAt);
  const glyph = context.theme.glyphs.thinking;
  const hint = context.expanded ? HIDE_HINT : SHOW_HINT;
  const label = `${glyph} ${THOUGHT_FOR} ${seconds}${SECONDS_SUFFIX} ${hint}`;
  return wrapText(label, context.width).map(thoughtLine);
}

/**
 * A thinking block: nothing while it is still streaming (its text would arrive line by
 * line and jump), then one muted italic line stating how long it took and how to open it.
 * Expanded, that line names the way back and the thought follows, muted and indented.
 */
function thinkingLines(entry: ThinkingEntry, context: LayoutContext): readonly StyledLine[] {
  if (entry.endedAt === undefined) return [];
  const header = thoughtHeader(entry, context);
  if (!context.expanded) return header;
  const thought = textLines(entry.text).flatMap((source) =>
    wrappedSource(source, context.width - GUTTER_WIDTH).map((content) => thoughtLine(GUTTER + content)),
  );
  return [...header, ...thought];
}

/**
 * One entry's lines. Every kind of the union is dispatched here; the kinds US-010 and
 * US-011 own draw nothing yet, so the whole union is present and none is forgotten.
 */
function layoutEntry(entry: TranscriptEntry, context: LayoutContext): readonly StyledLine[] {
  switch (entry.kind) {
    case "user":
      return userLines(entry, context);
    case "reply":
      return replyLines(entry, context);
    case "thinking":
      return thinkingLines(entry, context);
    case "welcome":
    case "tool":
    case "notice":
    case "warning":
    case "error":
    case "listing":
    case "interrupted":
      return [];
  }
}

/**
 * The transcript as styled lines: each entry's lines in order, with one empty line
 * between the entries that produced any — an entry with nothing to draw (a thinking block
 * still streaming) adds no separator.
 */
export function layoutTranscript(entries: readonly TranscriptEntry[], options: LayoutOptions): readonly StyledLine[] {
  const context: LayoutContext = {
    width: resolveWidth(options.width),
    theme: options.theme,
    expanded: options.expanded,
  };
  const lines: StyledLine[] = [];
  for (const entry of entries) {
    const entryLines = layoutEntry(entry, context);
    if (entryLines.length === 0) continue;
    if (lines.length > 0) lines.push(EMPTY_LINE);
    lines.push(...entryLines);
  }
  return lines;
}
