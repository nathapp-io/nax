/**
 * Span fitting — the column engine the chat models lay their text out with: segment styled
 * spans into grapheme clusters, group them into words, and fit the result to a column count
 * by wrapping, cutting or bounding a prefix.
 *
 * Everything here is measured in terminal columns with `displayWidth`, never in code units,
 * and a wrap never splits a cluster that fits on a line. A cluster wider than the whole line
 * — a long Indic conjunct is one grapheme many columns wide — is the one case where keeping
 * the line inside the width wins over keeping the cluster whole, and it is cut between code
 * points.
 *
 * Styles ride along with the glyphs, so a bold word, a link's muted suffix or a highlighted
 * code span survives a wrap intact. `markdown.ts` builds its lines with this engine, and
 * `layout.ts` re-wraps a line a model left wide with `wrapSpans`.
 */
import { displayWidth, MIN_LAYOUT_WIDTH, type Span, type StyledLine } from "./styled-line";

/** One column of space. */
export const SPACE = " ";

/**
 * The narrowest column budget a prefix may leave for content. It exceeds the widest
 * cluster a terminal draws (two columns), so a bounded prefix always leaves room for a
 * whole grapheme and a wrap never has to split one.
 */
const MIN_CONTENT_WIDTH = 4;

/** A span's style without its text — carried per glyph while wrapping. */
export type SpanStyle = Omit<Span, "text">;

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

/** One word with the separators that preceded it, kept styled so a wrap drops the right one. */
interface Word {
  readonly separator: readonly Glyph[];
  readonly glyphs: readonly Glyph[];
}

/** A width below the caller's floor (or not a number at all) is treated as that floor. */
export function resolveWidth(width: number, minimum: number): number {
  const floor = Number.isFinite(minimum) ? Math.max(1, Math.floor(minimum)) : MIN_LAYOUT_WIDTH;
  const requested = Number.isFinite(width) ? Math.floor(width) : floor;
  return Math.max(requested, floor);
}

export function styled(text: string, style: SpanStyle): Span {
  return { text, ...style };
}

function sameStyle(left: SpanStyle, right: SpanStyle): boolean {
  return (
    left.color === right.color &&
    left.background === right.background &&
    Boolean(left.bold) === Boolean(right.bold) &&
    Boolean(left.italic) === Boolean(right.italic) &&
    Boolean(left.inverse) === Boolean(right.inverse)
  );
}

/** Drop empty spans and merge neighbours that share a style, so a line has one span per run. */
export function mergeSpans(spans: readonly Span[]): StyledLine {
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

export function spansWidth(spans: readonly Span[]): number {
  return spans.reduce((total, span) => total + displayWidth(span.text), 0);
}

function styleOf(span: Span): SpanStyle {
  return {
    color: span.color,
    background: span.background,
    bold: span.bold,
    italic: span.italic,
    inverse: span.inverse,
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
export function boundPrefix(prefix: readonly Span[], width: number): readonly Span[] {
  const budget = Math.max(0, width - MIN_CONTENT_WIDTH);
  return spansWidth(prefix) <= budget ? prefix : clipPrefix(prefix, budget);
}

/** Blank columns as wide as `prefix` — where a continuation line of an indented block starts. */
export function hangingSpans(prefix: readonly Span[]): readonly Span[] {
  return [{ text: SPACE.repeat(spansWidth(prefix)) }];
}

/**
 * Wrap `spans` to `width`, drawing `prefix` on the first line and blank columns of the
 * same width on every continuation line — the shape an indented item or a quote needs.
 */
export function wrap(spans: readonly Span[], width: number, prefix: readonly Span[] = []): StyledLine[] {
  const bounded = boundPrefix(prefix, width);
  const prefixWidth = spansWidth(bounded);
  const continuation: Span[] = [{ text: SPACE.repeat(prefixWidth) }];
  const lines = fill(glyphsOf(spans), width - prefixWidth);
  if (lines.length === 0) return bounded.length === 0 ? [] : [mergeSpans(bounded)];
  return lines.map((line, index) => mergeSpans([...(index === 0 ? bounded : continuation), ...spansOf(line)]));
}

/** Keep at most `columns` columns of `spans`, dropping whole clusters from the right. */
export function cutSpans(spans: readonly Span[], columns: number): StyledLine {
  if (spansWidth(spans) <= columns) return mergeSpans([...spans]);
  const kept: Glyph[] = [];
  let used = 0;
  for (const glyph of glyphsOf(spans)) {
    const width = glyphWidth(glyph);
    if (used + width > columns) break;
    kept.push(glyph);
    used += width;
  }
  return spansOf(kept);
}

/**
 * Wrap spans that are **already styled** to `width` columns, drawing `prefix` on the first
 * line and blank columns of the same width on every continuation. Styles are carried
 * through by cluster, so a bold word, a link's muted suffix or a highlighted code span
 * survives the wrap intact.
 *
 * `layoutTranscript` uses this for a line a model leaves wide on purpose — a table's source
 * text, raw HTML, a quoted block — so that a narrow layout wraps it instead of cutting the
 * text away.
 */
export function wrapSpans(
  spans: readonly Span[],
  options: { readonly width: number; readonly prefix?: readonly Span[] },
): readonly StyledLine[] {
  return wrap(spans, resolveWidth(options.width, MIN_LAYOUT_WIDTH), options.prefix);
}
