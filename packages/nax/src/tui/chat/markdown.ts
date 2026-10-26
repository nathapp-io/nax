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
 * Every width is measured with `displayWidth` (a width below `MIN_LAYOUT_WIDTH` is
 * treated as `MIN_LAYOUT_WIDTH`), and every text becomes span text only after
 * `sanitizeText`, so a reply carrying `\u001b[?1049l` cannot leave the alternate
 * screen. Malformed input never throws: the lexer decides what it tokenises and an
 * unlexable document falls back to its own source lines.
 */
import { marked, type Token, type Tokens } from "marked";
import { displayWidth, MIN_LAYOUT_WIDTH, type Span, type StyledLine, sanitizeText } from "./styled-line";
import type { ChatTheme } from "./theme";

export interface RenderMarkdownOptions {
  readonly width: number;
  readonly theme: ChatTheme;
}

/** A span's style without its text — carried per character while wrapping. */
type SpanStyle = Omit<Span, "text">;

/** Every list level indents this many columns. */
const LIST_INDENT = "  ";
const UNORDERED_MARKER = "- ";
const NUMBER_SEPARATOR = ". ";
const SPACE = " ";
const NEWLINE_RUN = /\n+/g;
const SOURCE_LINE_BREAK = /\r\n|[\r\n]/;
const TRAILING_NEWLINE = "\n";

/** The characters of one line, each still carrying the style it was drawn with. */
interface StyledChar {
  readonly char: string;
  readonly style: SpanStyle;
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

function charsOf(spans: readonly Span[]): StyledChar[] {
  const chars: StyledChar[] = [];
  for (const span of spans) {
    const style: SpanStyle = {
      color: span.color,
      background: span.background,
      bold: span.bold,
      italic: span.italic,
    };
    for (const char of span.text) chars.push({ char, style });
  }
  return chars;
}

function spansOf(chars: readonly StyledChar[]): Span[] {
  const spans: Span[] = [];
  for (const char of chars) {
    const last = spans.at(-1);
    if (last !== undefined && sameStyle(last, char.style)) {
      spans[spans.length - 1] = { ...last, text: last.text + char.char };
      continue;
    }
    spans.push(styled(char.char, char.style));
  }
  return spans;
}

function isSeparator(char: StyledChar): boolean {
  return char.char === SPACE;
}

/** One word with the separators that preceded it, kept styled so a wrap drops the right one. */
interface Word {
  readonly separator: readonly StyledChar[];
  readonly chars: readonly StyledChar[];
}

/**
 * The line's characters grouped into words. Each word keeps the separators before it
 * with their own styles — a leading space inside a link's muted suffix must stay part
 * of that suffix, not move onto the span before it.
 */
function splitWords(chars: readonly StyledChar[]): Word[] {
  const words: Word[] = [];
  let separator: StyledChar[] = [];
  let word: StyledChar[] = [];
  for (const char of chars) {
    if (!isSeparator(char)) {
      word.push(char);
      continue;
    }
    if (word.length > 0) {
      words.push({ separator: words.length === 0 ? [] : separator, chars: word });
      word = [];
      separator = [];
    }
    separator.push(char);
  }
  if (word.length > 0) words.push({ separator: words.length === 0 ? [] : separator, chars: word });
  return words;
}

function charsWidth(chars: readonly StyledChar[]): number {
  return chars.reduce((total, char) => total + displayWidth(char.char), 0);
}

/** One ended line of characters. */
function flush(lines: StyledChar[][], current: StyledChar[]): StyledChar[] {
  if (current.length > 0) lines.push(current);
  return [];
}

/**
 * Greedy word wrap: a word that does not fit starts a new line, and a single word
 * wider than the line is cut at the line's width so no line ever overflows.
 */
function fill(chars: readonly StyledChar[], width: number): StyledChar[][] {
  const lines: StyledChar[][] = [];
  let current: StyledChar[] = [];
  let used = 0;
  for (const word of splitWords(chars)) {
    const gap = charsWidth(word.separator);
    if (current.length > 0 && used + gap + charsWidth(word.chars) > width) {
      current = flush(lines, current);
      used = 0;
    }
    if (current.length > 0) {
      current.push(...word.separator);
      used += gap;
    }
    for (const char of word.chars) {
      const charWidth = displayWidth(char.char);
      if (current.length > 0 && used + charWidth > width) {
        current = flush(lines, current);
        used = 0;
      }
      current.push(char);
      used += charWidth;
    }
  }
  flush(lines, current);
  return lines;
}

/**
 * Wrap `spans` to `width`, drawing `prefix` on the first line and blank columns of the
 * same width on every continuation line — the shape an indented item or a quote needs.
 */
function wrap(spans: readonly Span[], width: number, prefix: readonly Span[] = []): StyledLine[] {
  const prefixWidth = spansWidth(prefix);
  const continuation: Span[] = [{ text: SPACE.repeat(prefixWidth) }];
  const lines = fill(charsOf(spans), Math.max(1, width - prefixWidth));
  if (lines.length === 0) return prefix.length === 0 ? [] : [mergeSpans(prefix)];
  return lines.map((line, index) => mergeSpans([...(index === 0 ? prefix : continuation), ...spansOf(line)]));
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

/** A block child of a list item (a quote, a table, a fence) drawn indented under its marker. */
function indentBlockLines(child: Token, prefix: readonly Span[], context: BlockContext): StyledLine[] {
  const narrow: BlockContext = { ...context, width: Math.max(1, context.width - spansWidth(prefix)) };
  return blockLines(child, narrow).map((line) => mergeSpans([...prefix, ...line]));
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
        ? indentBlockLines(child, childPrefix, context)
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
  const prefix: readonly Span[] = [{ text: `${context.theme.glyphs.codeSide} `, color: "muted" }];
  const quoted: BlockContext = {
    ...context,
    width: Math.max(1, context.width - spansWidth(prefix)),
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
