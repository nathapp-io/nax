/**
 * Markdown — `renderMarkdown` turns a reply's markdown into styled lines.
 *
 * Parsing goes through the `marked` lexer, so the block and inline grammar is one
 * maintained implementation rather than a set of regexes here. Rendering turns each
 * token into `StyledLine`s: headings are bold, `**strong**` bold, `*em*` italic,
 * inline code `accent`, lists get a marker (ordered numbers `accent`), blockquotes
 * a muted `codeSide` prefix, a rule one line of `rule` glyphs, and a link its text
 * followed by a muted ` (<href>)`. A fence is framed by a muted `codeTop` line naming
 * its language and a muted `codeBottom` line, with a muted `codeSide` glyph and a space
 * before each code line — highlighted by scope when the language is one `syntax.ts`
 * registered, plain when it is not, and plain again if the highlighter fails. Tables,
 * raw HTML and anything else the lexer produced but this model does not style fall back
 * to their source text.
 *
 * Every width is measured in terminal columns and every wrap breaks between grapheme
 * clusters (`wrap.ts` owns that engine: cluster segmentation, word grouping, wrapping,
 * cutting and prefix bounding), so an emoji with a skin tone or a zero-width joiner is
 * never split. A `width` below the caller's floor — `MIN_LAYOUT_WIDTH` unless the caller
 * states its own with `minWidth`, which is how `layout.ts` hands over the content budget
 * behind a reply's gutter — is treated as that floor. Every text becomes span text only
 * after `sanitizeText`, so a reply carrying `\u001b[?1049l` cannot leave the alternate
 * screen. Malformed input never throws: the lexer decides what it tokenises and an
 * unlexable document falls back to its own source lines.
 */
import { marked, type Token, type Tokens } from "marked";
import { MIN_LAYOUT_WIDTH, type Span, type StyledLine, sanitizeText } from "./styled-line";
import { codeLines, fenceLanguage, highlightToHtml } from "./syntax";
import type { ChatTheme } from "./theme";
import {
  boundPrefix,
  cutSpans,
  hangingSpans,
  mergeSpans,
  resolveWidth,
  SPACE,
  type SpanStyle,
  spansWidth,
  styled,
  wrap,
} from "./wrap";

export interface RenderMarkdownOptions {
  readonly width: number;
  readonly theme: ChatTheme;
  /**
   * The narrowest width this caller means. It defaults to `MIN_LAYOUT_WIDTH`, the floor a
   * whole layout applies. A caller that hands over a *content budget* — `layout.ts` asks
   * for the width left behind a reply's gutter, which is legitimately narrower than a
   * layout — states its own floor here, so the content is wrapped to the budget it was
   * given instead of overflowing it.
   */
  readonly minWidth?: number;
  /**
   * Cut a code line wider than `width` at `width` instead of leaving it over-wide. A code
   * line is never wrapped (its own indentation is what makes it readable), so a caller
   * whose frame is exactly `width` — `layout.ts` — asks for the cut here. The default
   * leaves code whole, which is what a caller measuring the document itself wants.
   */
  readonly cutCode?: boolean;
}

/**
 * Injected seams. The highlighter is one so a test can make it fail and prove a fenced
 * block still renders — a live reply must never be lost to a grammar bug.
 */
export const _markdownDeps = {
  highlight: highlightToHtml,
};

/** Every list level indents this many columns. */
const LIST_INDENT = "  ";
const UNORDERED_MARKER = "- ";
const NUMBER_SEPARATOR = ". ";
const NEWLINE_RUN = /\n+/g;
const SOURCE_LINE_BREAK = /\r\n|[\r\n]/;
const TRAILING_NEWLINE = "\n";

/** One block token's rendering context: the width left to it and how deeply it nests. */
interface BlockContext {
  readonly width: number;
  readonly theme: ChatTheme;
  /** List nesting level; each level indents `LIST_INDENT`. */
  readonly level: number;
  /** Set inside a blockquote, where every span is italic. */
  readonly italic?: boolean;
  /** Set when the caller asked for a code line wider than `width` to be cut at it. */
  readonly cutCode?: boolean;
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

/** Draw `prefix` on the first of `lines` and a blank indent of the same width on the rest. */
function indentLines(lines: readonly StyledLine[], prefix: readonly Span[], width: number): StyledLine[] {
  const bounded = boundPrefix(prefix, width);
  const hanging = hangingSpans(bounded);
  return lines.map((line, index) => mergeSpans([...(index === 0 ? bounded : hanging), ...line]));
}

function indentSpans(level: number): readonly Span[] {
  return level <= 0 ? [] : [{ text: LIST_INDENT.repeat(level) }];
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

/**
 * A fenced block: a muted `codeTop` line naming the language, one line per code line behind
 * a muted `codeSide` glyph and a space, then a muted `codeBottom` line. Code lines are never
 * wrapped — the code's own indentation is what makes it readable, and a wrap would invent
 * line numbers that indentation contradicts. A caller that asks for `cutCode` gets every
 * line of the block cut at the width this block has here, which is the width left after the
 * enclosing list indent or quote glyph; without it the lines stay whole and the caller
 * decides what to do with an over-wide one.
 */
function codeBlockLines(code: Tokens.Code, context: BlockContext): StyledLine[] {
  const { glyphs } = context.theme;
  const language = fenceLanguage(code.lang);
  const side: Span = { text: `${glyphs.codeSide} `, color: "muted" };
  const body = codeLines(code.text, language, _markdownDeps.highlight).map((spans) => mergeSpans([side, ...spans]));
  const lines: StyledLine[] = [
    [styled(language === "" ? glyphs.codeTop : `${glyphs.codeTop} ${language}`, { color: "muted" })],
    ...body,
    [styled(glyphs.codeBottom, { color: "muted" })],
  ];
  return context.cutCode === true ? lines.map((line) => cutSpans(line, context.width)) : lines;
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
      return codeBlockLines(token as Tokens.Code, context);
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
    width: resolveWidth(options.width, options.minWidth ?? MIN_LAYOUT_WIDTH),
    theme: options.theme,
    level: 0,
    cutCode: options.cutCode,
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
