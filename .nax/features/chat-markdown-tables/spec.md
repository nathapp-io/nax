# SPEC: nax chat markdown tables

## Summary

Draw a markdown table in a `nax chat` reply as a box grid instead of its source text. The header row is bold, the borders are muted box-drawing glyphs (`+`, `-` and `|` under the ASCII glyph set), and each column honours its markdown alignment (left, center, right). When the natural grid is wider than the reply column, the widest columns shrink and their cells wrap inside the column; when the columns cannot fit even with each shrunk to at most 3 columns (a narrower column keeps its own width), every body row is drawn as a stacked block of `Header: value` lines separated by a muted rule. Every drawn line fits the width the table has, so the layout never wraps or cuts a table line.

This is the T3 item from the 2026-11-01 TUI bug check, deferred out of `chat-tui-esc-focus` by user ruling (2026-11-01). User rulings for this spec (2026-11-01): full box grid style; over-wide tables wrap cells first, then stack.

## Motivation

`renderMarkdown` (`packages/nax/src/tui/chat/markdown.ts`) styles headings, lists, quotes, rules and fences, but its `blockLines` default branch returns `sourceLines(token.raw)` for a table, so a reply listing stories or a comparison shows raw `| a | b |` / `| - | - |` text. `layout.ts` then wraps those source lines when they are wider than the column, which breaks the pipes across lines. Models answer with tables often (status summaries, option comparisons), so this is the most visible remaining markdown gap. The `marked` lexer already produces a `table` token with `header`, `rows` and `align`; it pads a short row with empty cells and drops cells beyond the header count (verified against marked 18.1.0), so only the drawing is missing.

## Design

### Approach

One deterministic renderer, no new dependency. A new pure module `packages/nax/src/tui/chat/markdown-table.ts` owns column sizing and drawing over already-styled cell spans, so it does not import `markdown.ts` (no import cycle): `markdown.ts` turns each cell's inline tokens into spans with its existing `inlineSpans`, builds a `TableModel`, and calls `renderTable` through its `_markdownDeps` seam.

**Grid geometry.** For `n` columns with content widths `w1..wn`, every grid line is `sum(w) + 3n + 1` columns wide: a vertical glyph, then per column a space, the cell content padded to `wi`, a space and a vertical glyph. Lines, top to bottom: a top border (`topLeft`, `horizontal` repeated `wi + 2` per column joined by `topJoin`, `topRight`), the header row(s), a separator (`midLeft`, `midJoin`, `midRight`) when there is at least one body row, the body rows with no separator between them, and a bottom border (`bottomLeft`, `bottomJoin`, `bottomRight`). Border and vertical glyphs are `muted`; header cell spans are bold on top of their own styles; padding spaces are unstyled.

**Column sizing (`columnWidths`).** The natural width of a column is the widest cell in it (header included), measured in terminal columns with `spansWidth`, and at least 1. The budget is `width - (3n + 1)`. If the natural widths fit the budget they are used. Otherwise each column's floor is `min(natural, MIN_CELL_WIDTH)` with `MIN_CELL_WIDTH = 3`; if the floors do not fit the budget, `columnWidths` returns `undefined` (stack). Otherwise it shrinks one column by one column-width at a time, always the currently widest column above its floor (on a tie, the leftmost), until the widths sum to the budget. Example: natural `[10, 4, 20]` with budget 20 gives `[8, 4, 8]`.

**Cells.** Each cell is wrapped to its column width with `wrap` from `wrap.ts` (word wrap, a word longer than the column breaks between grapheme clusters), an empty cell is one blank line, and a row is as tall as its tallest cell; shorter cells are padded with blank lines below. Each cell line, header cells included, is padded to the column width by its column's alignment: `left` and `null` pad on the right, `right` pads on the left, `center` puts `floor(extra / 2)` spaces on the left and the rest on the right. A row with fewer cells than the header draws the missing cells empty; cells beyond the header count are not drawn.

**Stacked layout.** When `columnWidths` returns `undefined`, each body row becomes one block: per column, the bold header spans, an unstyled `": "`, then the cell spans, wrapped together to the width with `wrap` (no hanging indent). A column whose header text is empty draws the cell spans alone. A column whose cell is empty or missing draws the bold header and `:` with no trailing space (`wrap` drops a trailing separator); a column whose header and cell are both empty draws no line. A body row whose every column draws no line produces no block and no rule, so two rules are never adjacent. Blocks are separated by one muted line of the rule glyph repeated to the width. A header-only table (no body rows) stacks as one bold line per header cell, wrapped to the width.

**Width floor.** `renderTable` treats a `width` below 1 as 1, so it never throws on a degenerate width; through `renderMarkdown` the width is already floored by `resolveWidth`.

**Context.** The table renders at the width its block has, so inside a list item it renders behind the marker's indent and inside a blockquote behind the quote glyph, with the quote's italic carried into every cell through `baseStyle`. Cell text goes through `inlineSpans`, which sanitises it (`sanitizeText`), so a cell carrying `\u001b[?1049l` cannot leave the alternate screen. A half-streamed table whose delimiter row has not arrived yet is lexed by marked as a paragraph and keeps rendering as today; it becomes a grid on the delta that completes the delimiter row.

### Integration

Symbols this feature only reads (verified on main `986e6f4a7`):

- `packages/nax/src/tui/chat/wrap.ts`: `wrap(spans: readonly Span[], width: number, prefix?: readonly Span[]): StyledLine[]`, `spansWidth(spans: readonly Span[]): number`, `mergeSpans(spans: readonly Span[]): StyledLine`, `styled(text: string, style: SpanStyle): Span`, `type SpanStyle = Omit<Span, "text">`.
- `packages/nax/src/tui/chat/styled-line.tsx`: `type Span`, `type StyledLine`, `MIN_LAYOUT_WIDTH = 10`, `plainText`, `sanitizeText`.
- `marked` 18.1.0 `Tokens.Table`: `{ type: "table"; raw: string; align: Array<"center" | "left" | "right" | null>; header: TableCell[]; rows: TableCell[][] }`, `Tokens.TableCell`: `{ text: string; tokens: Token[]; header: boolean; align: ... }`.
- `packages/nax/src/tui/chat/layout.ts` `replyLines`: calls `renderMarkdown(entry.text, { width: context.width - GUTTER_WIDTH, theme, minWidth: MIN_REPLY_WIDTH, cutCode: true })` and wraps any returned line still wider than the column in `prefixedLine`. Its behaviour is unchanged; a table line now never exceeds the width, so nothing reaches that wrap. Its doc comments (the module header and `replyLines`) and the `wrapSpans` doc comment in `wrap.ts` stop naming "a table's source text" as a wide line (US-004).

Symbols this feature changes. The baseline exists only to locate the code; it is never the interface to implement.

- `packages/nax/src/tui/chat/theme.ts` `ChatGlyphs`.
  Baseline: fields `bullet` .. `codeBottom` (strings) and `spinner: readonly string[]`.
  Target: the same fields plus `readonly table: TableGlyphs`, with a new exported interface
  ```ts
  export interface TableGlyphs {
    readonly horizontal: string;
    readonly vertical: string;
    readonly topLeft: string;
    readonly topJoin: string;
    readonly topRight: string;
    readonly midLeft: string;
    readonly midJoin: string;
    readonly midRight: string;
    readonly bottomLeft: string;
    readonly bottomJoin: string;
    readonly bottomRight: string;
  }
  ```
  Unicode set: `─ │ ┌ ┬ ┐ ├ ┼ ┤ └ ┴ ┘` (in field order). ASCII set: `horizontal` `-`, `vertical` `|`, every corner and join `+`.
- `packages/nax/src/tui/chat/markdown.ts` `_markdownDeps`.
  Baseline: `{ highlight: highlightToHtml }`.
  Target: `{ highlight: highlightToHtml, renderTable }`, with `renderTable` imported from `./markdown-table`.
- `packages/nax/src/tui/chat/markdown.ts` `blockLines`.
  Baseline: a `table` token falls to `default`, returning `sourceLines(token.raw)`.
  Target: `case "table"` builds a `TableModel` from the `Tokens.Table` (each header and row cell as `inlineSpans(cell.tokens, baseStyle(context))`, `align` copied) and returns `_markdownDeps.renderTable(model, { width: context.width, glyphs: context.theme.glyphs.table, rule: context.theme.glyphs.rule })`. The module header comment and the `default` branch comment stop listing tables among the source-text fallbacks.

New module `packages/nax/src/tui/chat/markdown-table.ts` (worked skeleton; names and signatures are the contract):

```ts
import type { Span, StyledLine } from "./styled-line";
import type { TableGlyphs } from "./theme";

export type TableAlign = "left" | "center" | "right" | null;

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

/** Content width per column for `width`, or undefined when the floors do not fit (stack). */
export function columnWidths(natural: readonly number[], width: number): readonly number[] | undefined;

/** The grid when the columns fit, otherwise the stacked layout. */
export function renderTable(model: TableModel, options: RenderTableOptions): StyledLine[];
```

Patterns to mirror: `codeBlockLines` and `ruleLine` in `markdown.ts` (muted frame glyphs from `context.theme.glyphs`, `mergeSpans`/`styled` construction), `_markdownDeps` as the injected seam (`markdown.test.ts` already swaps `highlight`). Module rules: `src/tui/chat/` sibling imports are relative (`./wrap`), `markdown-table.ts` is not added to the `src/tui/chat/index.ts` barrel (it has no consumer outside the directory), new source stays under the 600-line gate.

### Failure Handling

| Condition | Behaviour |
|---|---|
| Table wider than the width at natural column widths | Widest columns shrink toward `MIN_CELL_WIDTH`, cells wrap inside them. |
| Columns do not fit even at their floors | Stacked layout, every line within the width. |
| Table with a header and no body rows | Grid draws top border, header, bottom border (no separator); stacked draws one bold line per header cell. |
| Row with fewer or more cells than the header | Missing cells draw empty; extra cells are not drawn. |
| `TableModel` with zero header cells | `renderTable` returns no lines. |
| Cell text carrying terminal escape sequences | Stripped by `sanitizeText` through `inlineSpans` before it becomes span text. |
| Half-streamed table (delimiter row not yet arrived) | Lexed as a paragraph by marked, rendered as paragraph text as today. |

## Out of Scope

- Copying a rendered table back out as markdown source: the transcript holds the drawn grid, and a terminal selection copies the box glyphs.
- Horizontal scrolling or a "show source" toggle for wide tables; the wrap-then-stack rule is the only answer to width.
- Separator lines between body rows of the grid.
- Multi-line cell content from an inline `<br>` tag; it keeps rendering as the tag's text, as other raw HTML does.
- Tables in thinking blocks, user messages, tool results or listings; only replies go through `renderMarkdown`.
- Changing the fence glyphs (`codeTop`, `codeSide`, `codeBottom`) or sharing them with the table glyph set.
- A configurable `MIN_CELL_WIDTH`, column-width hints, or a per-table style choice.
- Adding any package dependency for table rendering; the renderer is built on `marked`'s existing table token and `wrap.ts`.
- Exporting `markdown-table.ts` from the `src/tui/chat/index.ts` barrel; it has no consumer outside `src/tui/chat/`.
- `markdown-table.ts` importing `markdown.ts`; cells arrive as styled spans so the dependency runs one way only.


## Stories

**US-001: Table glyphs and column sizing.** No dependencies. Workdir: `packages/nax`. Adds `TableGlyphs` and `ChatGlyphs.table` with the Unicode and ASCII sets to `theme.ts`, and creates `markdown-table.ts` with `TableAlign`, `TableModel`, `RenderTableOptions`, `MIN_CELL_WIDTH` and `columnWidths`.

**US-002: Drawing a table grid.** Depends on US-001. Workdir: `packages/nax`. Adds `renderTable` to `markdown-table.ts` for the case where `columnWidths` returns widths: borders, bold header, column alignment, wrapped cells and ragged rows. While `columnWidths` returns `undefined`, this story's `renderTable` may return any lines; US-003 defines them.

**US-003: The stacked table layout.** Depends on US-002. Workdir: `packages/nax`. `renderTable` draws each body row as a stacked `Header: value` block when `columnWidths` returns `undefined`, handles empty headers and values and the header-only case, and floors a width below 1 to 1.

**US-004: Tables in chat replies.** Depends on US-003. Workdir: `packages/nax`. `markdown.ts` adds `renderTable` to `_markdownDeps` and draws a `table` token through it from `blockLines`, with cells styled by `inlineSpans` in the block's context; the `markdown.ts` header and fallback comments, the `layout.ts` module header and `replyLines` comments and the `wrapSpans` comment in `packages/nax/src/tui/chat/wrap.ts` stop naming tables as source-text lines.

### Context Files

**US-001**
- `packages/nax/src/tui/chat/theme.ts`
- `packages/nax/test/unit/tui/chat/theme.test.ts`
- `packages/nax/src/tui/chat/styled-line.tsx`

**US-002**
- `packages/nax/src/tui/chat/markdown-table.ts` — created by US-001, extended here
- `packages/nax/src/tui/chat/wrap.ts`
- `packages/nax/src/tui/chat/theme.ts`
- `packages/nax/src/tui/chat/markdown.ts`
- `packages/nax/test/unit/tui/chat/markdown-table.test.ts` — created by US-001, extended here

**US-003**
- `packages/nax/src/tui/chat/markdown-table.ts` — created by US-001, extended here
- `packages/nax/src/tui/chat/wrap.ts`
- `packages/nax/test/unit/tui/chat/markdown-table.test.ts` — created by US-001, extended here

**US-004**
- `packages/nax/src/tui/chat/markdown.ts`
- `packages/nax/src/tui/chat/markdown-table.ts` — created by US-001, completed by US-003
- `packages/nax/test/unit/tui/chat/markdown.test.ts`
- `packages/nax/src/tui/chat/layout.ts`
- `packages/nax/test/unit/tui/chat/layout.test.ts`

### Creates

**US-001**
- `packages/nax/src/tui/chat/markdown-table.ts`
- `packages/nax/test/unit/tui/chat/markdown-table.test.ts`

### Modifies

**US-004**
- `packages/nax/test/unit/tui/chat/markdown.test.ts` — the test "keeps a table as its source text" asserts that `| a | b |\n| - | - |\n| 1 | 2 |` renders as its three source lines; a table now renders as a box grid, so that test is replaced by one asserting the grid lines `┌───┬───┐`, `│ a │ b │`, `├───┼───┤`, `│ 1 │ 2 │`, `└───┴───┘`. The raw HTML fallback test beside it stays unchanged. The spy test restores `_markdownDeps.renderTable` in an `afterEach` covering it (extend the existing hook that restores `_markdownDeps.highlight` in the fenced-code describe, or give the new describe its own), so the spy cannot leak into later tests.
- `packages/nax/test/unit/tui/chat/layout.test.ts` — the test "wraps a table's source line instead of clipping it" asserts that the squashed layout of a 4-column header-only table equals its source text with whitespace removed; the table is now drawn by the renderer (stacked at this width), so the test instead asserts every line is at most `NARROW_WIDTH` columns and that the lines in order hold the header words `alpha`, `bravo`, `charlie`, `delta` and no `|` character.

### Seams

- `renderTable` (US-002, US-003) is called by `markdown.ts` `blockLines` (US-004) through `_markdownDeps.renderTable`; US-004's spy AC stubs it and triggers `renderMarkdown`, the entry point `layout.ts` `replyLines` calls.
- `columnWidths` (US-001) decides grid versus stacked inside `renderTable`; US-002's shrink AC and its width-17 grid AC, and US-003's width-16 stacked AC, are only satisfiable when `renderTable` uses it.
- `ChatGlyphs.table` (US-001) is what US-004 passes as `glyphs`; US-004's ASCII AC proves the theme's set reaches the drawing.

## Acceptance Criteria

### US-001

1. [unit] `resolveChatTheme({ env: {}, colorLevel: 3 })` returns `glyphs.table` equal to `{ horizontal: "─", vertical: "│", topLeft: "┌", topJoin: "┬", topRight: "┐", midLeft: "├", midJoin: "┼", midRight: "┤", bottomLeft: "└", bottomJoin: "┴", bottomRight: "┘" }`.
2. [unit] `resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 3 })` returns `glyphs.table` with `horizontal` `"-"`, `vertical` `"|"`, and `"+"` for each of `topLeft`, `topJoin`, `topRight`, `midLeft`, `midJoin`, `midRight`, `bottomLeft`, `bottomJoin`, `bottomRight`.
3. [unit] `MIN_CELL_WIDTH` imported from `markdown-table.ts` equals 3.
4. [unit] `columnWidths([3, 2], 40)` returns `[3, 2]`: natural widths that fit the budget `40 - 7` are kept.
5. [unit] `columnWidths([10, 4, 20], 30)` returns `[8, 4, 8]`: the budget `30 - 10 = 20` is reached by shrinking the widest column one step at a time, the leftmost on a tie.
6. [unit] `columnWidths([6, 23], 25)` returns `[6, 12]`.
7. [unit] `columnWidths([2, 9], 10)` returns `undefined`, because the floors `min(2, 3) + min(9, 3) = 5` exceed the budget `10 - 7 = 3`.
8. [unit] `columnWidths([1, 1, 1, 1], 17)` returns `[1, 1, 1, 1]` and `columnWidths([1, 1, 1, 1], 16)` returns `undefined`: a column narrower than `MIN_CELL_WIDTH` keeps its natural width as its floor.
9. [unit] `columnWidths([5, 5], 13)` returns `[3, 3]`, every column at its floor exactly filling the budget `13 - 7 = 6`.
10. [unit] `columnWidths([], 40)` returns `[]`.

### US-002

1. [unit] `renderTable` with header `[[{ text: "a" }], [{ text: "bb" }]]`, one row `[[{ text: "ccc" }], [{ text: "d" }]]`, align `[null, null]`, width 40, the Unicode table glyphs and rule `"─"` returns lines whose plain texts are `"┌─────┬────┐"`, `"│ a   │ bb │"`, `"├─────┼────┤"`, `"│ ccc │ d  │"`, `"└─────┴────┘"`.
2. [unit] In that `renderTable` output every span holding a border or vertical glyph has color `muted`.
3. [unit] In that `renderTable` output the spans holding `a` and `bb` are bold and the span holding `ccc` is not bold.
4. [unit] `renderTable` given a header cell span styled `{ color: "accent" }` draws it with `color: "accent"` and `bold: true` in the header row.
5. [unit] `renderTable` with header `a`, `bb`, one row `ccc`, `d`, align `[null, "right"]` and width 40 draws the body row `"│ ccc │  d │"`.
6. [unit] `renderTable` with one column, header `"head5"`, one row `"ab"`, align `["center"]` and width 40 draws the body row `"│  ab   │"`: 3 spare columns put 1 space left and 2 right of the text, inside the 1-space cell padding.
7. [unit] `renderTable` with one column, header `"head5"`, one row `"ab"`, align `["left"]` and width 40 draws the body row `"│ ab    │"`.
8. [unit] `renderTable` with one column, header `"ab"`, one row `"head5"`, align `["right"]` and width 40 draws the header row `"│    ab │"`: a header cell takes its column's alignment.
9. [unit] `renderTable` with header `Story`, `Description`, one row `US-001`, `add the esc layer model`, align `[null, null]` and width 25 returns plain texts `"┌────────┬──────────────┐"`, `"│ Story  │ Description  │"`, `"├────────┼──────────────┤"`, `"│ US-001 │ add the esc  │"`, `"│        │ layer model  │"`, `"└────────┴──────────────┘"`.
10. [unit] Every line `renderTable` returns for a grid is exactly `sum(column widths) + 3 × columns + 1` columns wide measured with `spansWidth`, including when a cell holds the double-width text `"日本"` (a column of natural width 4).
11. [unit] `renderTable` given a row with fewer cells than the header draws the missing cells as blank padding.
12. [unit] `renderTable` given a row with more cells than the header draws only the first header-count cells.
13. [unit] `renderTable` given a header and no rows returns three lines: the top border, the header row and the bottom border, with no `├` separator line.
14. [unit] `renderTable` given an empty header returns an empty array.
15. [unit] `renderTable` with header `a`, `b`, `c`, `d`, rows `1 2 3 4` and `5 6 7 8`, align all `null` and width 17 returns a grid whose first line is `"┌───┬───┬───┬───┐"`.
16. [unit] `renderTable` with the ASCII table glyphs, header `a`, `bb`, one row `ccc`, `d`, align `[null, null]` and width 40 returns `"+-----+----+"`, `"| a   | bb |"`, `"+-----+----+"`, `"| ccc | d  |"`, `"+-----+----+"`.

### US-003

1. [unit] `renderTable` with header `a`, `b`, `c`, `d`, rows `1 2 3 4` and `5 6 7 8`, width 16 and rule `"─"` returns the stacked plain texts `"a: 1"`, `"b: 2"`, `"c: 3"`, `"d: 4"`, `"────────────────"`, `"a: 5"`, `"b: 6"`, `"c: 7"`, `"d: 8"`.
2. [unit] In that stacked `renderTable` output the span holding each header label is bold and the span text beginning `: ` is not bold.
3. [unit] In that stacked `renderTable` output every span of the rule line has color `muted`.
4. [unit] `renderTable` with header `a`, `b`, `c`, `d`, one row `1`, `2 3 4 5 6 7 8 9`, `3`, `4` and width 10 draws the `b` value across more than one line, and every line it returns is at most 10 columns wide.
5. [unit] `renderTable` with header `a` and an empty second header cell, one row `1`, `2`, and width 8 returns `"a: 1"`, `"2"`: an empty header draws the value alone.
6. [unit] `renderTable` with header `a`, `b`, `c`, one row with only the cell `1`, and width 12 returns `"a: 1"`, `"b:"`, `"c:"`.
7. [unit] `renderTable` with header `a` and an empty second header cell, one row `1` and an empty second cell, and width 8 returns only `"a: 1"`.
8. [unit] `renderTable` given header `alpha`, `bravo`, `charlie`, `delta`, no rows, and width 18 returns the four lines `"alpha"`, `"bravo"`, `"charlie"`, `"delta"`, each span bold.
9. [unit] `renderTable` with header `a`, `b`, one row `1`, `2` and width 0 does not throw and returns the same lines as at width 1.

### US-004

1. [unit] With `_markdownDeps.renderTable` replaced by a spy returning `[[{ text: "T" }]]`, `renderMarkdown("| a | b |\n| :- | -: |\n| 1 | 2 |", { width: 40, theme })` returns the single line `"T"`, and the spy was called once with a model whose header plain texts are `["a", "b"]`, row plain texts `[["1", "2"]]`, align `["left", "right"]`, and options `{ width: 40, glyphs: theme.glyphs.table, rule: theme.glyphs.rule }`.
2. [unit] `renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |", { width: 40, theme })` with the real renderer returns the plain texts `"┌───┬───┐"`, `"│ a │ b │"`, `"├───┼───┤"`, `"│ 1 │ 2 │"`, `"└───┴───┘"`.
3. [unit] `renderMarkdown` of a table whose body cell is `**x**` returns a bold span `x`.
4. [unit] `renderMarkdown` of a table whose body cell is `` `y` `` returns a span `y` with color `accent`.
5. [unit] `renderMarkdown` of a table whose body cell is `a\u001b[31mb` returns the text `ab` with no ESC byte in any span.
6. [unit] `renderMarkdown("para\n\n| a | b |\n| - | - |\n| 1 | 2 |", { width: 40, theme })` returns `"para"`, one empty line, then the five grid lines.
7. [unit] `renderMarkdown("- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |", { width: 40, theme })` returns `"- item"` followed directly by the five grid lines, each behind two spaces of hanging indent (`"  ┌───┬───┐"` first).
8. [unit] `renderMarkdown("> | a | b |\n> | - | - |\n> | 1 | 2 |", { width: 40, theme })` returns five lines each starting with the muted quote glyph and a space, and the spans holding `a`, `b`, `1` and `2` are italic.
9. [unit] `renderMarkdown` with the ASCII theme (`NAX_ASCII: "1"`) draws `| a | b |\n| - | - |\n| 1 | 2 |` as `"+---+---+"`, `"| a | b |"`, `"+---+---+"`, `"| 1 | 2 |"`, `"+---+---+"`.
10. [unit] `renderMarkdown("| a | b |", { width: 40, theme })`, a header row whose delimiter row has not arrived, returns the paragraph text `"| a | b |"` (a regression pin: it holds today and must keep holding).
11. [integration] `layoutTranscript` of a reply whose text is `| a | b |\n| - | - |\n| 1 | 2 |` at width 40 draws the bullet glyph and a space before `"┌───┬───┐"` on the first line and two spaces before each following grid line.
12. [integration] `layoutTranscript` of a reply holding the table with header `alpha`, `bravo`, `charlie`, `delta` and one row `one two`, `three four`, `five six`, `seven eight` at width 20 draws no line wider than 20 columns, draws no `│` glyph (the table stacks at the 18-column reply width), and keeps every header and cell word in the output.
