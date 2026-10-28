import { displayWidth, plainText, type Span, type StyledLine } from "./styled-line";
import { visibleRange } from "./viewport";

export interface TranscriptPoint {
  readonly line: number;
  readonly column: number;
}
export interface Selection {
  readonly anchor: TranscriptPoint;
  readonly focus: TranscriptPoint;
}
export interface ViewportGeometry {
  readonly top: number;
  readonly height: number;
  readonly total: number;
  readonly offset: number;
  readonly unseen: number;
}

/** Map terminal cells to the exact padded window drawn by ViewportRows. */
export function transcriptPointAt(geometry: ViewportGeometry, x: number, y: number): TranscriptPoint | undefined {
  const { top, height, total, offset, unseen } = geometry;
  const row = y - 1 - top;
  if (x < 1 || row < 0 || row >= height) return undefined;
  const { start, end } = visibleRange(total, height, offset);
  const marker = unseen > 0 ? 1 : 0;
  const count = Math.max(0, end - start - marker);
  if (row >= count) return undefined;
  return { line: start + row, column: x - 1 };
}

function ordered(selection: Selection): readonly [TranscriptPoint, TranscriptPoint] {
  const { anchor, focus } = selection;
  return anchor.line < focus.line || (anchor.line === focus.line && anchor.column <= focus.column)
    ? [anchor, focus]
    : [focus, anchor];
}
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Convert inclusive display cells to whole-grapheme UTF-16 offsets, across spans. */
function textRange(text: string, start: number, end: number): readonly [number, number] {
  let column = 0;
  let from = text.length;
  let to = text.length;
  let found = false;
  for (const { segment, index } of SEGMENTER.segment(text)) {
    const width = displayWidth(segment);
    if (column + width > start && column <= end) {
      if (!found) from = index;
      to = index + segment.length;
      found = true;
    }
    column += width;
  }
  return [from, to];
}
function lineRange(line: StyledLine, index: number, selection: Selection): readonly [number, number] {
  const [start, end] = ordered(selection);
  return textRange(
    plainText(line),
    index === start.line ? start.column : 0,
    index === end.line ? end.column : Number.POSITIVE_INFINITY,
  );
}

export function selectedText(lines: readonly StyledLine[], selection: Selection): string {
  const [start, end] = ordered(selection);
  const result: string[] = [];
  for (let index = Math.max(0, start.line); index <= Math.min(end.line, lines.length - 1); index += 1) {
    const line = lines[index];
    const [from, to] = lineRange(line, index, selection);
    result.push(plainText(line).slice(from, to).replace(/ +$/u, ""));
  }
  return result.join("\n");
}

/** Split styled runs at selection boundaries without losing original attributes. */
export function highlightLine(line: StyledLine, index: number, selection: Selection): StyledLine {
  const [start, end] = ordered(selection);
  if (index < start.line || index > end.line) return line;
  const [from, to] = lineRange(line, index, selection);
  if (from === to) return line;
  const result: Span[] = [];
  let offset = 0;
  for (const span of line) {
    const left = Math.max(0, Math.min(span.text.length, from - offset));
    const right = Math.max(left, Math.min(span.text.length, to - offset));
    if (left > 0) result.push({ ...span, text: span.text.slice(0, left) });
    if (right > left) result.push({ ...span, text: span.text.slice(left, right), inverse: true });
    if (right < span.text.length) result.push({ ...span, text: span.text.slice(right) });
    offset += span.text.length;
  }
  return result;
}
