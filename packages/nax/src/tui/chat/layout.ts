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
 * through `sanitizeText` before it becomes span text — a reply, a tool's preview or a
 * thinking line carrying `\u001b[?1049l` cannot leave the alternate screen.
 *
 * A tool card is drawn from `toolCardModel`: header, result summary, an Edit's diff and,
 * while collapsed, the count of the lines ctrl+o would reveal. The model reports tones, not
 * colours, so the same card draws on a truecolour, a 16-colour or a colourless terminal —
 * a diff line falls back to `danger`/`success` when the theme has no background to band it
 * with.
 *
 * One entry's lines are computed once per `(width, expanded)` pair and reused while the
 * entry object is the same one: the reducer replaces only the entries an event touched, so
 * a streaming reply re-lays out alone and the rest of a long transcript is not redrawn.
 * `_layoutDeps.layoutEntry` is the injected per-entry renderer, which is what makes that
 * observable.
 *
 * The dispatcher covers the whole `TranscriptEntry` union; the welcome, notice, warning,
 * error, listing and interrupted cases are filled in by US-011.
 */
import { renderMarkdown } from "./markdown";
import { displayWidth, MIN_LAYOUT_WIDTH, type Span, type StyledLine, sanitizeText } from "./styled-line";
import type { ChatColorToken, ChatTheme } from "./theme";
import { type CardLine, type DiffLine, secondsBetween, type ToolCardModel, toolCardModel } from "./tool-card";
import type { TranscriptEntry } from "./transcript-model";
import { wrapSpans } from "./wrap";

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
type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

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
/** The colour a tool card's bullet takes, by the tone its model reported. */
const BULLET_COLORS = {
  running: "muted",
  success: "success",
  danger: "danger",
} as const satisfies Record<ToolCardModel["tone"], ChatColorToken>;
/** What a collapsed card's last line promises. */
const EXPAND_HINT = "lines (ctrl+o to expand)";
/** Opens the count of the lines a collapsed card withholds. */
const HIDDEN_LINE_MARK = "+";
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

/**
 * The text's lines: sanitised, with the line break that ends a file's last line taken off.
 * An **empty** text has no lines; a text that is only that line break — `"\n"`, or one that
 * is left as `""` after it is taken off — is one blank source line, which the layout keeps.
 */
function textLines(text: string): readonly string[] {
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

/**
 * One line behind its prefix. A line that fits is drawn whole; a wider one is wrapped at
 * word boundaries with blank columns as wide as the prefix on every continuation, so a
 * narrow layout loses neither a card's output nor a reply's words.
 */
function prefixedLine(spans: readonly Span[], prefix: readonly Span[], context: LayoutContext): readonly StyledLine[] {
  const prefixed = line([...prefix, ...spans]);
  if (lineWidth(prefixed) <= context.width) return [prefixed];
  return wrapSpans(spans, { width: context.width, prefix });
}

/**
 * A reply: its markdown rendered into the columns left behind the gutter, the first line
 * behind the bullet glyph and the rest behind two spaces, with code lines cut — never
 * wrapped — by the renderer at the width the block actually has. A line `renderMarkdown`
 * leaves wide on purpose — a table's source text, raw HTML, a quote — reaches
 * `prefixedLine` still wide and is wrapped there rather than lost.
 */
function replyLines(entry: ReplyEntry, context: LayoutContext): readonly StyledLine[] {
  const rendered = renderMarkdown(entry.text, {
    width: context.width - GUTTER_WIDTH,
    theme: context.theme,
    minWidth: MIN_REPLY_WIDTH,
    cutCode: true,
  });
  const marker = styled(`${context.theme.glyphs.bullet}${SPACE}`);
  const gutter = styled(GUTTER);
  return rendered.flatMap((spans, index) => prefixedLine(spans, [index === 0 ? marker : gutter], context));
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

/** `  ⎿  ` — the gutter, the result glyph, and the two columns that follow it. */
function resultPrefix(theme: ChatTheme): string {
  return `${GUTTER}${theme.glyphs.result}${SPACE}${SPACE}`;
}

/** Where a card's later summary lines, its diff lines and its expand hint start. */
function cardIndent(theme: ChatTheme): string {
  return SPACE.repeat(displayWidth(resultPrefix(theme)));
}

/**
 * The card's header: the bullet in its tone's colour, then a space, the title, and the
 * argument in bold parentheses — the title alone when the call carries no argument.
 */
function toolHeader(model: ToolCardModel, context: LayoutContext): readonly StyledLine[] {
  const bullet = styled(context.theme.glyphs.bullet, { color: BULLET_COLORS[model.tone] });
  const argument = model.arg === undefined ? [] : [styled(`(${sanitizeText(model.arg)})`, { bold: true })];
  return prefixedLine([styled(sanitizeText(model.title)), ...argument], [bullet, styled(SPACE)], context);
}

/** The colour a summary line takes; a plain line keeps the terminal's own. */
function summaryColor(tone: CardLine["tone"]): ChatColorToken | undefined {
  return tone === "plain" ? undefined : tone;
}

/** The result summary: the glyph opens the first line, five blank columns the rest. */
function toolSummaryLines(model: ToolCardModel, context: LayoutContext): readonly StyledLine[] {
  return model.summary.flatMap((line, index) => {
    const style: SpanStyle = { color: summaryColor(line.tone) };
    const prefix = index === 0 ? resultPrefix(context.theme) : cardIndent(context.theme);
    return prefixedLine([styled(sanitizeText(line.text), style)], [styled(prefix, style)], context);
  });
}

/**
 * A diff line's style: the theme's background band when it has one, and the tone's colour
 * when it does not — a 16-colour terminal has no background to spare for a diff, and a
 * diff drawn in no colour at all would be unreadable.
 */
function diffStyle(sign: DiffLine["sign"], theme: ChatTheme): SpanStyle {
  if (sign === " ") return {};
  const background: ChatColorToken = sign === "-" ? "diffRemove" : "diffAdd";
  if (theme.colors[background] !== undefined) return { background };
  const color: ChatColorToken = sign === "-" ? "danger" : "success";
  return { color };
}

/** An Edit's diff behind the card's indent, each line banded by what it did to the file. */
function toolDiffLines(model: ToolCardModel, context: LayoutContext): readonly StyledLine[] {
  const indent = cardIndent(context.theme);
  return model.diff.flatMap((line) => {
    const style = diffStyle(line.sign, context.theme);
    return prefixedLine([styled(`${line.sign}${sanitizeText(line.text)}`, style)], [styled(indent, style)], context);
  });
}

/** The last line of a collapsed card: how many lines ctrl+o would reveal. */
function toolHiddenLine(model: ToolCardModel, context: LayoutContext): readonly StyledLine[] {
  if (model.hiddenLines === 0) return [];
  const label = `${context.theme.glyphs.ellipsis} ${HIDDEN_LINE_MARK}${model.hiddenLines} ${EXPAND_HINT}`;
  const muted: SpanStyle = { color: "muted" };
  return prefixedLine([styled(label, muted)], [styled(cardIndent(context.theme), muted)], context);
}

/**
 * A tool card: its header, the result summary, an Edit's diff and, while the card is
 * collapsed, the count of the lines ctrl+o would reveal. The model carries tones, not
 * colours, so the same card draws on any terminal.
 */
function toolLines(entry: ToolEntry, context: LayoutContext): readonly StyledLine[] {
  const model = toolCardModel(entry, { expanded: context.expanded });
  return [
    ...toolHeader(model, context),
    ...toolSummaryLines(model, context),
    ...toolDiffLines(model, context),
    ...toolHiddenLine(model, context),
  ];
}

/**
 * One entry's lines. Every kind of the union is dispatched here; the kinds US-011 owns
 * draw nothing yet, so the whole union is present and none is forgotten.
 */
function layoutEntry(entry: TranscriptEntry, context: LayoutContext): readonly StyledLine[] {
  switch (entry.kind) {
    case "user":
      return userLines(entry, context);
    case "reply":
      return replyLines(entry, context);
    case "thinking":
      return thinkingLines(entry, context);
    case "tool":
      return toolLines(entry, context);
    case "welcome":
    case "notice":
    case "warning":
    case "error":
    case "listing":
    case "interrupted":
      return [];
  }
}

/**
 * Injected seams. `layoutEntry` draws one entry for a layout context, and the per-entry
 * cache in `layoutTranscript` is only observable through it, so a test can count what a
 * call actually recomputed.
 */
export const _layoutDeps = {
  layoutEntry,
};

/** How many widths one entry's lines are kept for: a resize there and back stays cached. */
const MAX_LAYOUT_VARIANTS = 4;
/** The separator between the two numbers of a variant key; no width or flag can hold it. */
const VARIANT_KEY_SEPARATOR = ":";

/** The lines one entry object has been laid out as, and the theme they were drawn for. */
interface CachedEntry {
  readonly theme: ChatTheme;
  readonly variants: Map<string, readonly StyledLine[]>;
}

/**
 * Per-entry lines, keyed by the entry object itself so an entry the transcript dropped is
 * collected with it. The reducer replaces only the entries an event touched, so an
 * unchanged entry keeps its object — and this cache keeps its lines.
 */
const LINE_CACHE = new WeakMap<TranscriptEntry, CachedEntry>();

function variantKey(width: number, expanded: boolean): string {
  return `${width}${VARIANT_KEY_SEPARATOR}${expanded}`;
}

/** The variants to store this entry's next line set in, discarding a stale theme's. */
function variantsFor(entry: TranscriptEntry, theme: ChatTheme): Map<string, readonly StyledLine[]> {
  const cached = LINE_CACHE.get(entry);
  if (cached !== undefined && cached.theme === theme) return cached.variants;
  const variants = new Map<string, readonly StyledLine[]>();
  LINE_CACHE.set(entry, { theme, variants });
  return variants;
}

/** Make room for one more variant by dropping the one stored longest ago. */
function evictOldest(variants: Map<string, readonly StyledLine[]>): void {
  const oldest = variants.keys().next();
  if (!oldest.done) variants.delete(oldest.value);
}

/**
 * One entry's lines for this context, computed once per `(width, expanded)` pair. A theme
 * is resolved once per chat session, so a different theme object means the cached lines
 * were drawn with the colours and glyphs of another one and cannot be reused.
 */
function cachedLines(entry: TranscriptEntry, context: LayoutContext): readonly StyledLine[] {
  const variants = variantsFor(entry, context.theme);
  const key = variantKey(context.width, context.expanded);
  const cached = variants.get(key);
  if (cached !== undefined) return cached;
  const lines = _layoutDeps.layoutEntry(entry, context);
  if (variants.size >= MAX_LAYOUT_VARIANTS) evictOldest(variants);
  variants.set(key, lines);
  return lines;
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
    const entryLines = cachedLines(entry, context);
    if (entryLines.length === 0) continue;
    if (lines.length > 0) lines.push(EMPTY_LINE);
    lines.push(...entryLines);
  }
  return lines;
}
