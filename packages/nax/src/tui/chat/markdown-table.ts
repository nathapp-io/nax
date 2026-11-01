/**
 * Markdown tables — the pure model and column-sizing contract the chat pipeline draws a
 * table with.
 *
 * A table arrives here as `TableModel`: cells are already-styled spans (the caller's inline
 * renderer produced them), so this module never parses markdown and never imports
 * `markdown.ts` — the dependency runs one way only. Everything here is a pure function of
 * its arguments, which is what lets the sizing be tested without building styled lines.
 *
 * `columnWidths` owns the one decision the drawing cannot make for itself: whether the
 * table fits beside its frame at all. A grid costs three columns per column (one vertical
 * rule and two padding columns) plus a closing rule, so the content budget is
 * `width - (3n + 1)`. While the natural widths fit that budget they are used as they are.
 * Otherwise every column shrinks towards its floor — `MIN_CELL_WIDTH`, or its own natural
 * width when that is already narrower, so a one-column cell never grows — widest first and
 * leftmost on a tie, one column at a time. When the floors themselves do not fit, no grid
 * can honour the width and the caller stacks the table instead; `undefined` is that answer.
 *
 * Glyphs are theme-owned (`ChatGlyphs.table`) and passed in, so an ASCII terminal draws a
 * frame of `-`, `|` and `+` without this module knowing which set is active.
 */
import type { Span } from "./styled-line";
import type { TableGlyphs } from "./theme";

/** A column's alignment, as a markdown table's delimiter row states it. `null` is left. */
export type TableAlign = "left" | "center" | "right" | null;

/** A table ready to draw: styled cells, one alignment per column. */
export interface TableModel {
  readonly header: readonly (readonly Span[])[];
  readonly rows: readonly (readonly (readonly Span[])[])[];
  readonly align: readonly TableAlign[];
}

export interface RenderTableOptions {
  readonly width: number;
  readonly glyphs: TableGlyphs;
  /** The rule glyph the stacked layout separates rows with. */
  readonly rule: string;
}

/** The narrowest a column shrinks to before the table stacks. */
export const MIN_CELL_WIDTH = 3;

/** Every column costs one vertical rule plus the space on either side of its content. */
const COLUMN_FRAME_WIDTH = 3;

/** The closing rule after the last column. */
const CLOSING_RULE_WIDTH = 1;

/** The content columns a grid leaves for its cells at `width`. */
function contentBudget(width: number, columns: number): number {
  return width - (COLUMN_FRAME_WIDTH * columns + CLOSING_RULE_WIDTH);
}

/** A column never measures zero: an all-empty column still draws one blank column. */
function atLeastOneColumn(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
}

/** A column shrinks no further than `MIN_CELL_WIDTH`, and a narrower one keeps its width. */
function floorWidth(natural: number): number {
  return Math.min(natural, MIN_CELL_WIDTH);
}

function sum(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width, 0);
}

/**
 * The index of the widest column still above its floor, the leftmost on a tie, or -1 when
 * every column already sits at its floor.
 */
function widestAboveFloor(widths: readonly number[], floors: readonly number[]): number {
  let candidate = -1;
  for (let index = 0; index < widths.length; index += 1) {
    if (widths[index] <= floors[index]) continue;
    if (candidate === -1 || widths[index] > widths[candidate]) candidate = index;
  }
  return candidate;
}

/**
 * Shrink one column-width at a time from the widest column until the widths fill the
 * budget exactly. The floors are known to fit, so the loop always terminates.
 */
function shrinkToBudget(natural: readonly number[], floors: readonly number[], budget: number): readonly number[] {
  const widths = [...natural];
  let total = sum(widths);
  while (total > budget) {
    const index = widestAboveFloor(widths, floors);
    if (index === -1) return widths;
    widths[index] -= 1;
    total -= 1;
  }
  return widths;
}

/** Content width per column for `width`, or undefined when the floors do not fit (stack). */
export function columnWidths(natural: readonly number[], width: number): readonly number[] | undefined {
  if (natural.length === 0) return [];
  const naturals = natural.map(atLeastOneColumn);
  const budget = contentBudget(width, naturals.length);
  if (sum(naturals) <= budget) return naturals;
  const floors = naturals.map(floorWidth);
  if (sum(floors) > budget) return undefined;
  return shrinkToBudget(naturals, floors, budget);
}
