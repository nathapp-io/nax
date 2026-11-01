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
 *
 * `renderTable` draws the grid the widths allow: a muted top border, the bold header row, a
 * muted separator, the body rows, and a muted bottom border. A cell is wrapped to its column
 * width and padded to it on the side its alignment asks for, so every drawn line is exactly
 * `sum(widths) + 3n + 1` columns wide and the caller never has to re-wrap a table line.
 *
 * When even the floors do not fit, no grid can honour the width and the table stacks: each
 * body row becomes a block of `Header: value` lines, one per column, each wrapped to the
 * whole width with no hanging indent, and a muted rule across the width separates the
 * blocks. A column with no header draws its value alone, one with no value draws
 * `Header:` — `wrap` drops the trailing separator — and one with neither draws nothing, so
 * an empty row leaves no block and two rules are never adjacent. A header-only table stacks
 * as one bold line per header cell.
 */
import type { Span, StyledLine } from "./styled-line";
import type { TableGlyphs } from "./theme";
import { mergeSpans, SPACE, spansWidth, styled, wrap } from "./wrap";

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

/** The space on either side of a cell's content — the width a border runs along. */
const CELL_PADDING = COLUMN_FRAME_WIDTH - 1;

/** The closing rule after the last column. */
const CLOSING_RULE_WIDTH = 1;

/**
 * The separator between a stacked line's label and its value. Unstyled, so a value never
 * carries the label's style, and `wrap` drops it when there is no value to follow it.
 */
const LABEL_SEPARATOR = ": ";

/** The content columns a grid leaves for its cells at `width`. */
function contentBudget(width: number, columns: number): number {
  return width - (COLUMN_FRAME_WIDTH * columns + CLOSING_RULE_WIDTH);
}

/**
 * A width below one column is drawn as one: an all-empty column still claims a column, and
 * a degenerate render width never makes the drawing throw.
 */
function atLeastOne(width: number): number {
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
  const naturals = natural.map(atLeastOne);
  const budget = contentBudget(width, naturals.length);
  if (sum(naturals) <= budget) return naturals;
  const floors = naturals.map(floorWidth);
  if (sum(floors) > budget) return undefined;
  return shrinkToBudget(naturals, floors, budget);
}

/** The per-column geometry one table is drawn with. */
interface ColumnPlan {
  readonly widths: readonly number[];
  readonly aligns: readonly TableAlign[];
  /** The glyph closing each side of every content line. */
  readonly vertical: string;
}

/** The three joints one horizontal border runs between. */
interface BorderEdges {
  readonly left: string;
  readonly join: string;
  readonly right: string;
}

/** A border or vertical glyph run: frame glyphs are muted, whatever the theme's colours. */
function muted(text: string): Span {
  return styled(text, { color: "muted" });
}

/** Header cells are bold on top of whatever the inline renderer styled them with. */
function boldSpans(cell: readonly Span[]): readonly Span[] {
  return cell.map((span) => ({ ...span, bold: true }));
}

/** A table's natural column widths: its widest cell per column, the header included. */
function naturalWidths(model: TableModel): readonly number[] {
  const widths: number[] = [];
  for (let index = 0; index < model.header.length; index += 1) {
    const cells = [model.header.at(index), ...model.rows.map((row) => row.at(index))];
    widths.push(Math.max(0, ...cells.map((cell) => (cell === undefined ? 0 : spansWidth(cell)))));
  }
  return widths;
}

/** One column's cells, brought to the header's count: missing cells are empty, extra dropped. */
function normalized(cells: readonly (readonly Span[])[], columns: number): readonly (readonly Span[])[] {
  return Array.from({ length: columns }, (_, index) => cells.at(index) ?? []);
}

/** A cell wrapped to its column width; an empty cell is one blank line. */
function cellLines(cell: readonly Span[] | undefined, width: number): readonly StyledLine[] {
  const lines = wrap(cell ?? [], width);
  return lines.length === 0 ? [[]] : lines;
}

/** A cell line padded to the column width on the side its alignment asks for. */
function paddedCell(line: StyledLine, width: number, align: TableAlign): readonly Span[] {
  const spare = Math.max(0, width - spansWidth(line));
  const left = align === "right" ? spare : align === "center" ? Math.floor(spare / 2) : 0;
  return [{ text: SPACE.repeat(left) }, ...line, { text: SPACE.repeat(spare - left) }];
}

/** One drawn line of a row: every cell padded to its column, framed by vertical rules. */
function rowLine(cells: readonly (StyledLine | undefined)[], plan: ColumnPlan): StyledLine {
  const spans: Span[] = [muted(plan.vertical)];
  for (let index = 0; index < plan.widths.length; index += 1) {
    const align = plan.aligns.at(index) ?? null;
    spans.push({ text: SPACE }, ...paddedCell(cells.at(index) ?? [], plan.widths[index], align), { text: SPACE });
    spans.push(muted(plan.vertical));
  }
  return mergeSpans(spans);
}

/** One row drawn as tall as its tallest cell; shorter cells are blank below it. */
function rowBlock(cells: readonly (readonly Span[] | undefined)[], plan: ColumnPlan): StyledLine[] {
  const wrapped = plan.widths.map((width, index) => cellLines(cells.at(index), width));
  const height = Math.max(1, ...wrapped.map((lines) => lines.length));
  return Array.from({ length: height }, (_, line) =>
    rowLine(
      wrapped.map((lines) => lines.at(line)),
      plan,
    ),
  );
}

/** A horizontal border: each column's run `CELL_PADDING` wider than its content. */
function borderLine(widths: readonly number[], edges: BorderEdges, horizontal: string): StyledLine {
  const segments = widths.map((width) => horizontal.repeat(width + CELL_PADDING));
  return [muted(`${edges.left}${segments.join(edges.join)}${edges.right}`)];
}

/** The whole grid: top border, header, a separator when a body follows, body rows, bottom. */
function gridLines(model: TableModel, options: RenderTableOptions, plan: ColumnPlan): StyledLine[] {
  const { glyphs } = options;
  const top = borderLine(
    plan.widths,
    { left: glyphs.topLeft, join: glyphs.topJoin, right: glyphs.topRight },
    glyphs.horizontal,
  );
  const bottom = borderLine(
    plan.widths,
    { left: glyphs.bottomLeft, join: glyphs.bottomJoin, right: glyphs.bottomRight },
    glyphs.horizontal,
  );
  const header = rowBlock(model.header.map(boldSpans), plan);
  if (model.rows.length === 0) return [top, ...header, bottom];
  const separator = borderLine(
    plan.widths,
    { left: glyphs.midLeft, join: glyphs.midJoin, right: glyphs.midRight },
    glyphs.horizontal,
  );
  const body = model.rows.flatMap((row) => rowBlock(normalized(row, plan.widths.length), plan));
  return [top, ...header, separator, ...body, bottom];
}

/** The rule between two stacked blocks: one muted run as wide as the render. */
function stackRule(width: number, rule: string): StyledLine {
  return [muted(rule.repeat(width))];
}

/**
 * One column of a stacked block: `Header: value` when both halves have text, and the half
 * that does when the other is empty. Two empty halves draw nothing.
 */
function stackedColumn(header: readonly Span[], cell: readonly Span[], width: number): StyledLine[] {
  const label = spansWidth(header) === 0 ? null : boldSpans(header);
  const value = spansWidth(cell) === 0 ? null : cell;
  if (label === null) return value === null ? [] : wrap(value, width);
  return wrap([...label, { text: LABEL_SEPARATOR }, ...(value ?? [])], width);
}

/** One body row as a stacked block: its columns' lines in column order, unwrapped by column. */
function stackedBlock(model: TableModel, row: readonly (readonly Span[])[], width: number): StyledLine[] {
  const cells = normalized(row, model.header.length);
  const lines: StyledLine[] = [];
  for (let index = 0; index < model.header.length; index += 1) {
    lines.push(...stackedColumn(model.header[index], cells[index], width));
  }
  return lines;
}

/**
 * The stacked layout: one block per body row, separated by a muted rule so two rules are
 * never adjacent — a row that draws nothing leaves no block. A header-only table has no
 * blocks and stacks as one bold line per header cell.
 */
function stackedLines(model: TableModel, width: number, rule: string): StyledLine[] {
  if (model.rows.length === 0) return model.header.flatMap((header) => wrap(boldSpans(header), width));
  const blocks = model.rows.map((row) => stackedBlock(model, row, width)).filter((block) => block.length > 0);
  return blocks.flatMap((block, index) => (index === 0 ? block : [stackRule(width, rule), ...block]));
}

/**
 * The grid when the columns fit, otherwise the stacked layout. A width below one column is
 * drawn as one column, so a degenerate width stacks instead of throwing.
 */
export function renderTable(model: TableModel, options: RenderTableOptions): StyledLine[] {
  const columns = model.header.length;
  if (columns === 0) return [];
  const width = atLeastOne(options.width);
  const widths = columnWidths(naturalWidths(model), width);
  if (widths === undefined) return stackedLines(model, width, options.rule);
  const aligns = Array.from({ length: columns }, (_, index) => model.align.at(index) ?? null);
  return gridLines(model, options, { widths, aligns, vertical: options.glyphs.vertical });
}
