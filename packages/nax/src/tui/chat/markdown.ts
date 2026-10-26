/**
 * Markdown — `renderMarkdown` turns a reply's markdown into styled lines.
 *
 * Parsing goes through the `marked` lexer, so the block and inline grammar is one
 * maintained implementation rather than a set of regexes here. Rendering turns each
 * token into `StyledLine`s: headings are bold, `**strong**` bold, `*em*` italic,
 * inline code `accent`, lists get a marker (ordered numbers `accent`), blockquotes
 * a muted `codeSide` prefix, a rule one line of `rule` glyphs, and a link its text
 * followed by a muted ` (<href>)`. Tables, raw HTML and anything else the lexer
 * produced but this model does not style fall back to their source text.
 *
 * Every width is measured with `displayWidth` and every wrap breaks between grapheme
 * clusters, so an emoji with a skin tone or a zero-width joiner is never split (a
 * `width` below `MIN_LAYOUT_WIDTH` is treated as `MIN_LAYOUT_WIDTH`, and a prefix — an
 * indent, a marker, a quote glyph — is bounded to leave `MIN_CONTENT_WIDTH` columns of
 * content). Every text becomes span text only after `sanitizeText`, so a reply carrying
 * `\u001b[?1049l` cannot leave the alternate screen. Malformed input never throws: the
 * lexer decides what it tokenises and an unlexable document falls back to its own
 * source lines.
 */
import { marked, type Token, type Tokens } from "marked";
import { displayWidth, MIN_LAYOUT_WIDTH, type Span, type StyledLine, sanitizeText } from "./styled-line";
import type { ChatTheme } from "./theme";

export interface RenderMarkdownOptions {
  readonly width: number;
  readonly theme: ChatTheme;
}

/** A span's style without its text — carried per glyph while wrapping. */
type SpanStyle = Omit<Span, "text">;

/** Every list level indents this many columns. */
const LIST_INDENT = "  ";
const UNORDERED_MARKER = "- ";
const NUMBER_SEPARATOR = ". ";
const SPACE = " ";
const NEWLINE_RUN = /\n+/g;
const SOURCE_LINE_BREAK = /\r\n|[\r\n]/;
const TRAILING_NEWLINE = "\n";

/**
 * The narrowest column budget a prefix may leave for content. It exceeds the widest
 * cluster a terminal draws (two columns), so a bounded prefix always leaves room for a
 * whole grapheme and a wrap never has to split one.
 */
const MIN_CONTENT_WIDTH = 4;

/** Splits text into user-perceived characters, so an emoji with a skin tone or a ZWJ stays whole. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One styled run of a grapheme — a modifier or a ZWJ join may cross a span boundary. */
interface GlyphPart {
  readonly text: string;
  readonly style: SpanStyle;
}

/** One grapheme cluster of a line as the styled fragments it is drawn from. Indivisible. */
interface Glyph {
  readonly glyph: string;
  readonly parts: readonly GlyphPart[];
}

/** One block token's rendering context: the width left to it and how deeply it nests. */
interface BlockContext {
  readonly width: number;
  readonly theme: ChatTheme;
  /** List nesting level; each level indents `LIST_INDENT`. */
  readonly level: number;
  /** Set inside a blockquote, where every span is italic. */
  readonly italic?: boolean;
}

/** A width below `MIN_LAYOUT_WIDTH` (or not a number at all) is treated as the minimum. */
function resolveWidth(width: number): number {
  const requested = Number.isFinite(width) ? Math.floor(width) : MIN_LAYOUT_WIDTH;
  return Math.max(requested, MIN_LAYOUT_WIDTH);
}

function styled(text: string, style: SpanStyle): Span {
  return { text, ...style };
}

function sameStyle(left: SpanStyle, right: SpanStyle): boolean {
  return (
    left.color === right.color &&
    left.background === right.background &&
    Boolean(left.bold) === Boolean(right.bold) &&
    Boolean(left.italic) === Boolean(right.italic)
  );
}

/** Drop empty spans and merge neighbours that share a style, so a line has one span per run. */
function mergeSpans(spans: readonly Span[]): StyledLine {
  const merged: Span[] = [];
  for (const span of spans) {
    if (span.text === "") continue;
    const last = merged.at(-1);
    if (last !== undefined && sameStyle(last, span)) {
      merged[merged.length - 1] = { ...last, text: last.text + span.text };
      continue;
    }
    merged.push(span);
  }
  return merged;
}

function spansWidth(spans: readonly Span[]): number {
  return spans.reduce((total, span) => total + displayWidth(span.text), 0);
}

/** Text that becomes span text: escapes stripped, then a line break folded to a space. */
function singleLine(text: string): string {
  return sanitizeText(text).replace(NEWLINE_RUN, SPACE);
}

/** Source text kept verbatim — one plain line per line, drawn exactly as it arrived. */
function sourceLines(text: string): StyledLine[] {
  const body = text.endsWith(TRAILING_NEWLINE) ? text.slice(0, -TRAILING_NEWLINE.length) : text;
  if (body === "") return [];
  return body.split(SOURCE_LINE_BREAK).map((line) => [{ text: sanitizeText(line) }]);
}

function styleOf(span: Span): SpanStyle {
  return {
    color: span.color,
    background: span.background,
    bold: span.bold,
    italic: span.italic,
  };
}

/** The styled fragments of `combined` between two UTF-16 offsets, in span order. */
function fragmentsBetween(
  parts: readonly GlyphPart[],
  offsets: readonly number[],
  start: number,
  end: number,
): GlyphPart[] {
  const fragments: GlyphPart[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const partStart = offsets[index];
    const partEnd = partStart + parts[index].text.length;
    if (partEnd <= start || partStart >= end) continue;
    const from = Math.max(start, partStart) - partStart;
    const to = Math.min(end, partEnd) - partStart;
    fragments.push({ text: parts[index].text.slice(from, to), style: parts[index].style });
  }
  return fragments;
}

/**
 * Segment the spans' text **as one string** and then attach the style fragments: a skin-tone
 * modifier or a ZWJ join can sit in a different span from the base character it belongs to,
 * so segmenting each span on its own would tear the cluster apart.
 */
function glyphsOf(spans: readonly Span[]): Glyph[] {
  const parts: GlyphPart[] = spans
    .filter((span) => span.text !== "")
    .map((span) => ({ text: span.text, style: styleOf(span) }));
  const offsets: number[] = [];
  let combined = "";
  for (const part of parts) {
    offsets.push(combined.length);
    combined += part.text;
  }
  if (combined === "") return [];
  return Array.from(GRAPHEME_SEGMENTER.segment(combined), (segment) => ({
    glyph: segment.segment,
    parts: fragmentsBetween(parts, offsets, segment.index, segment.index + segment.segment.length),
  }));
}

function glyphWidth(glyph: Glyph): number {
  return displayWidth(glyph.glyph);
}

function spansOf(glyphs: readonly Glyph[]): readonly Span[] {
  return mergeSpans(glyphs.flatMap((glyph) => glyph.parts.map((part) => styled(part.text, part.style))));
}

function isSeparator(glyph: Glyph): boolean {
  return glyph.glyph === SPACE;
}

/** One word with the separators that preceded it, kept styled so a wrap drops the right one. */
interface Word {
  readonly separator: readonly Glyph[];
  readonly glyphs: readonly Glyph[];
}

/**
 * The line's glyphs grouped into words. Each word keeps the separators before it with
 * their own styles — a leading space inside a link's muted suffix must stay part of
 * that suffix, not move onto the span before it.
 */
function splitWords(glyphs: readonly Glyph[]): Word[] {
  const words: Word[] = [];
  let separator: Glyph[] = [];
  let word: Glyph[] = [];
  for (const glyph of glyphs) {
    if (!isSeparator(glyph)) {
      word.push(glyph);
      continue;
    }
    if (word.length > 0) {
      words.push({ separator: words.length === 0 ? [] : separator, glyphs: word });
      word = [];
      separator = [];
    }
    separator.push(glyph);
  }
  if (word.length > 0) words.push({ separator: words.length === 0 ? [] : separator, glyphs: word });
  return words;
}

function glyphsWidth(glyphs: readonly Glyph[]): number {
  return glyphs.reduce((total, glyph) => total + glyphWidth(glyph), 0);
}

/** One ended line of glyphs. */
function flush(lines: Glyph[][], current: Glyph[]): Glyph[] {
  if (current.length > 0) lines.push(current);
  return [];
}

/**
 * Cut one cluster into pieces no wider than `width`, splitting between code points. This is
 * the fallback for a cluster that cannot fit at all (a long Indic conjunct, for instance, is
 * one grapheme many columns wide): the cluster is no longer intact either way, so keeping the
 * line inside the width wins over keeping it whole.
 */
function splitGlyph(glyph: Glyph, width: number): Glyph[] {
  const pieces: Glyph[] = [];
  let fragments: GlyphPart[] = [];
  let text = "";
  let used = 0;
  const endPiece = () => {
    if (text === "") return;
    pieces.push({ glyph: text, parts: fragments });
    fragments = [];
    text = "";
    used = 0;
  };
  for (const part of glyph.parts) {
    let run = "";
    const keepRun = () => {
      if (run !== "") fragments.push({ text: run, style: part.style });
      run = "";
    };
    for (const point of part.text) {
      const pointWidth = displayWidth(point);
      if (text !== "" && used + pointWidth > width) {
        keepRun();
        endPiece();
      }
      run += point;
      text += point;
      used += pointWidth;
    }
    keepRun();
  }
  endPiece();
  return pieces;
}

/** One cluster, or the pieces it must occupy when it is wider than the whole line. */
function glyphPieces(glyph: Glyph, width: number): readonly Glyph[] {
  return glyphWidth(glyph) > width ? splitGlyph(glyph, width) : [glyph];
}

/**
 * Greedy word wrap over grapheme clusters: a word that does not fit starts a new line,
 * and a single word wider than the line is cut at the line's width so no line overflows.
 * A cluster is never split when it fits — `MIN_CONTENT_WIDTH` guarantees room for the
 * widest one a terminal draws — and a cluster wider than the whole line falls back to
 * `splitGlyph`.
 */
function fill(glyphs: readonly Glyph[], width: number): Glyph[][] {
  const lines: Glyph[][] = [];
  let current: Glyph[] = [];
  let used = 0;
  for (const word of splitWords(glyphs)) {
    const gap = glyphsWidth(word.separator);
    if (current.length > 0 && used + gap + glyphsWidth(word.glyphs) > width) {
      current = flush(lines, current);
      used = 0;
    }
    if (current.length > 0) {
      current.push(...word.separator);
      used += gap;
    }
    for (const glyph of word.glyphs) {
      for (const piece of glyphPieces(glyph, width)) {
        const pieceWidth = glyphWidth(piece);
        if (current.length > 0 && used + pieceWidth > width) {
          current = flush(lines, current);
          used = 0;
        }
        current.push(piece);
        used += pieceWidth;
      }
    }
  }
  flush(lines, current);
  return lines;
}

/**
 * Keep at most `maxWidth` columns of `spans`, dropping from the left: a marker is the
 * meaningful end of a prefix, and the indent before it is what may go.
 */
function clipPrefix(spans: readonly Span[], maxWidth: number): readonly Span[] {
  const glyphs = glyphsOf(spans);
  let kept = 0;
  let start = glyphs.length;
  while (start > 0) {
    const width = glyphWidth(glyphs[start - 1]);
    if (kept + width > maxWidth) break;
    kept += width;
    start -= 1;
  }
  return spansOf(glyphs.slice(start));
}

/**
 * Bound a prefix to leave at least `MIN_CONTENT_WIDTH` columns of content, so a deep
 * indent or a long ordered marker can never squeeze — or overflow — the line.
 */
function boundPrefix(prefix: readonly Span[], width: number): readonly Span[] {
  const budget = Math.max(0, width - MIN_CONTENT_WIDTH);
  return spansWidth(prefix) <= budget ? prefix : clipPrefix(prefix, budget);
}

/**
 * Wrap `spans` to `width`, drawing `prefix` on the first line and blank columns of the
 * same width on every continuation line — the shape an indented item or a quote needs.
 */
function wrap(spans: readonly Span[], width: number, prefix: readonly Span[] = []): StyledLine[] {
  const bounded = boundPrefix(prefix, width);
  const prefixWidth = spansWidth(bounded);
  const continuation: Span[] = [{ text: SPACE.repeat(prefixWidth) }];
  const lines = fill(glyphsOf(spans), width - prefixWidth);
  if (lines.length === 0) return bounded.length === 0 ? [] : [mergeSpans(bounded)];
  return lines.map((line, index) => mergeSpans([...(index === 0 ? bounded : continuation), ...spansOf(line)]));
}

/** Draw `prefix` on the first of `lines` and a blank indent of the same width on the rest. */
function indentLines(lines: readonly StyledLine[], prefix: readonly Span[], width: number): StyledLine[] {
  const bounded = boundPrefix(prefix, width);
  const hanging = hangingSpans(bounded);
  return lines.map((line, index) => mergeSpans([...(index === 0 ? bounded : hanging), ...line]));
}

function indentSpans(level: number): readonly Span[] {
  return level <= 0 ? [] : [{ text: LIST_INDENT.repeat(level) }];
}

/** Blank columns as wide as `prefix` — where a continuation line of an indented block starts. */
function hangingSpans(prefix: readonly Span[]): readonly Span[] {
  return [{ text: SPACE.repeat(spansWidth(prefix)) }];
}

function baseStyle(context: BlockContext): SpanStyle {
  return context.italic === true ? { italic: true } : {};
}

function textTokenSpans(token: Tokens.Text, style: SpanStyle): readonly Span[] {
  const nested = token.tokens;
  if (nested !== undefined && nested.length > 0) return inlineSpans(nested, style);
  return [styled(singleLine(token.text), style)];
}

function inlineToken(token: Token, style: SpanStyle): readonly Span[] {
  switch (token.type) {
    case "strong":
      return inlineSpans((token as Tokens.Strong).tokens, { ...style, bold: true });
    case "em":
      return inlineSpans((token as Tokens.Em).tokens, { ...style, italic: true });
    case "del":
      return inlineSpans((token as Tokens.Del).tokens, { ...style, italic: true });
    case "codespan":
      return [styled(singleLine((token as Tokens.Codespan).text), { ...style, color: "accent" })];
    case "link": {
      const link = token as Tokens.Link;
      const suffix = styled(singleLine(` (${link.href})`), { ...style, color: "muted" });
      return [...inlineSpans(link.tokens, style), suffix];
    }
    case "image":
      return [styled(singleLine((token as Tokens.Image).text), style)];
    case "br":
      return [styled(SPACE, style)];
    case "escape":
      return [styled(singleLine((token as Tokens.Escape).text), style)];
    case "html":
      return [styled(singleLine((token as Tokens.Tag).text), style)];
    case "text":
      return textTokenSpans(token as Tokens.Text, style);
    default:
      return [styled(singleLine(token.raw), style)];
  }
}

function inlineSpans(tokens: readonly Token[], style: SpanStyle = {}): readonly Span[] {
  return tokens.flatMap((token) => inlineToken(token, style));
}

function orderedMarker(number: number): readonly Span[] {
  return [{ text: `${number}${NUMBER_SEPARATOR}`, color: "accent" }];
}

/** Inline content of a list item's own line, or undefined when the child is a block. */
function itemContent(child: Token, context: BlockContext): readonly Span[] | undefined {
  const style = baseStyle(context);
  if (child.type === "paragraph") return inlineSpans((child as Tokens.Paragraph).tokens, style);
  if (child.type === "text") return textTokenSpans(child as Tokens.Text, style);
  return undefined;
}

/** A block child of a list item (a quote, a heading, a table) drawn under its marker. */
function itemBlockLines(child: Token, prefix: readonly Span[], context: BlockContext): StyledLine[] {
  const bounded = boundPrefix(prefix, context.width);
  const narrow: BlockContext = { ...context, width: context.width - spansWidth(bounded) };
  // The marker belongs to the item's first line only; the child's own lines never repeat it.
  return indentLines(blockLines(child, narrow), bounded, context.width);
}

function itemLines(item: Tokens.ListItem, prefix: readonly Span[], context: BlockContext): StyledLine[] {
  const hanging = hangingSpans(prefix);
  const lines: StyledLine[] = [];
  for (const child of item.tokens) {
    if (child.type === "list") {
      lines.push(...listLines(child as Tokens.List, { ...context, level: context.level + 1 }));
      continue;
    }
    const childPrefix = lines.length === 0 ? prefix : hanging;
    const content = itemContent(child, context);
    lines.push(
      ...(content === undefined
        ? itemBlockLines(child, childPrefix, context)
        : wrap(content, context.width, childPrefix)),
    );
  }
  return lines;
}

function listLines(list: Tokens.List, context: BlockContext): StyledLine[] {
  const start = typeof list.start === "number" ? list.start : 1;
  const indent = indentSpans(context.level);
  return list.items.flatMap((item, index) => {
    const marker: readonly Span[] = list.ordered ? orderedMarker(start + index) : [{ text: UNORDERED_MARKER }];
    return itemLines(item, [...indent, ...marker], context);
  });
}

function blockquoteLines(blockquote: Tokens.Blockquote, context: BlockContext): StyledLine[] {
  const prefix = boundPrefix([{ text: `${context.theme.glyphs.codeSide} `, color: "muted" }], context.width);
  const quoted: BlockContext = {
    ...context,
    width: context.width - spansWidth(prefix),
    italic: true,
  };
  const lines = blockquote.tokens.flatMap((child) => blockLines(child, quoted));
  return lines.map((line) => mergeSpans([...prefix, ...line]));
}

function ruleLine(context: BlockContext): StyledLine[] {
  return [[{ text: context.theme.glyphs.rule.repeat(context.width), color: "muted" }]];
}

function blockLines(token: Token, context: BlockContext): StyledLine[] {
  switch (token.type) {
    case "heading":
      return wrap(inlineSpans((token as Tokens.Heading).tokens, { ...baseStyle(context), bold: true }), context.width);
    case "paragraph":
      return wrap(inlineSpans((token as Tokens.Paragraph).tokens, baseStyle(context)), context.width);
    case "list":
      return listLines(token as Tokens.List, context);
    case "blockquote":
      return blockquoteLines(token as Tokens.Blockquote, context);
    case "hr":
      return ruleLine(context);
    case "space":
      return [];
    case "def":
      // A link reference definition is markup that the link already resolved; drawing it
      // would repeat the URL as content.
      return [];
    case "code":
      return sourceLines((token as Tokens.Code).text);
    default:
      // Tables, raw HTML and any token this model does not style keep their source text.
      return sourceLines(token.raw);
  }
}

/**
 * Render markdown as styled lines. Malformed input never throws: it renders as the
 * lexer tokenises it, and an unlexable document falls back to its own source lines.
 */
export function renderMarkdown(text: string, options: RenderMarkdownOptions): readonly StyledLine[] {
  const context: BlockContext = {
    width: resolveWidth(options.width),
    theme: options.theme,
    level: 0,
  };
  let tokens: readonly Token[];
  try {
    tokens = marked.lexer(text);
  } catch {
    // The lexer has no throw path for well-formed UTF-8, but this text is a live,
    // possibly half-streamed reply: show its source rather than losing the turn.
    return sourceLines(text);
  }
  return tokens.flatMap((token) => blockLines(token, context));
}
