import { describe, expect, test } from "bun:test";
import { columnWidths, MIN_CELL_WIDTH, renderTable, type TableAlign, type TableModel } from "@/tui/chat/markdown-table";
import { plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme, type TableGlyphs } from "@/tui/chat/theme";
import { spansWidth } from "@/tui/chat/wrap";

describe("MIN_CELL_WIDTH", () => {
  test("AC-3: the narrowest a column shrinks to is three content columns", () => {
    expect(MIN_CELL_WIDTH).toBe(3);
  });
});

interface SizingCase {
  readonly ac: string;
  readonly why: string;
  readonly natural: readonly number[];
  readonly width: number;
  readonly expected: readonly number[] | undefined;
}

/**
 * `columnWidths` keeps the natural widths while they fit the budget
 * `width - (3n + 1)`, otherwise shrinks the widest column above its floor one column
 * at a time, and gives up (stack) when even the floors do not fit.
 */
const SIZING_CASES = [
  {
    ac: "AC-4",
    why: "natural widths that fit the budget 40 - 7 are kept",
    natural: [3, 2],
    width: 40,
    expected: [3, 2],
  },
  {
    ac: "AC-5",
    why: "the budget 30 - 10 = 20 is reached by shrinking the widest column, leftmost on a tie",
    natural: [10, 4, 20],
    width: 30,
    expected: [8, 4, 8],
  },
  {
    ac: "AC-6",
    why: "the wide column shrinks to the 25 - 7 = 18 budget",
    natural: [6, 23],
    width: 25,
    expected: [6, 12],
  },
  {
    ac: "AC-7",
    why: "the floors min(2, 3) + min(9, 3) = 5 exceed the budget 10 - 7 = 3",
    natural: [2, 9],
    width: 10,
    expected: undefined,
  },
  {
    ac: "AC-8",
    why: "a column narrower than MIN_CELL_WIDTH keeps its natural width as its floor",
    natural: [1, 1, 1, 1],
    width: 17,
    expected: [1, 1, 1, 1],
  },
  {
    ac: "AC-9",
    why: "the floors 1 + 1 + 1 + 1 exceed the budget 16 - 13 = 3",
    natural: [1, 1, 1, 1],
    width: 16,
    expected: undefined,
  },
  {
    ac: "AC-10",
    why: "every column sits at its floor, exactly filling the budget 13 - 7 = 6",
    natural: [5, 5],
    width: 13,
    expected: [3, 3],
  },
] satisfies readonly SizingCase[];

describe("columnWidths", () => {
  test.each(SIZING_CASES)("$ac: $why", ({ natural, width, expected }) => {
    expect(columnWidths(natural, width)).toEqual(expected);
  });

  test("AC-11: no columns means no widths", () => {
    expect(columnWidths([], 40)).toEqual([]);
  });

  test("a column that measured zero columns still claims one", () => {
    expect(columnWidths([0, 2], 40)).toEqual([1, 2]);
  });

  test("a column that did not measure as a number claims one column", () => {
    expect(columnWidths([Number.NaN, 4], 40)).toEqual([1, 4]);
  });
});

const UNICODE_THEME: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
const ASCII_THEME: ChatTheme = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 3 });

const TABLE_WIDTH = 40;

/** The `RenderTableOptions` a theme draws a table with at `width`. */
function tableOptions(theme: ChatTheme, width: number = TABLE_WIDTH) {
  return { width, glyphs: theme.glyphs.table, rule: theme.glyphs.rule };
}

/** One unstyled cell holding `text`. */
function cell(text: string): readonly Span[] {
  return [{ text }];
}

function texts(lines: readonly StyledLine[]): readonly string[] {
  return lines.map(plainText);
}

/** A table model — every argument spells out the cells the drawing tests use. */
function table(
  header: readonly (readonly Span[])[],
  rows: readonly (readonly (readonly Span[])[])[],
  align: readonly TableAlign[],
): TableModel {
  return { header, rows, align };
}

/** The two-column table every frame test draws: header `a` `bb`, one row `ccc` `d`. */
const BASIC = table([cell("a"), cell("bb")], [[cell("ccc"), cell("d")]], [null, null]);

function renderBasic(theme: ChatTheme = UNICODE_THEME): readonly StyledLine[] {
  return renderTable(BASIC, tableOptions(theme));
}

/** Every span of `lines` holding a border or vertical glyph of `glyphs`. */
function frameSpans(lines: readonly StyledLine[], glyphs: TableGlyphs): readonly Span[] {
  const frame = new Set(Object.values(glyphs));
  return lines.flatMap((line) => line.filter((span) => [...span.text].some((character) => frame.has(character))));
}

/** Every span of `lines` whose text contains `needle`. */
function spansHolding(lines: readonly StyledLine[], needle: string): readonly Span[] {
  return lines.flatMap((line) => line.filter((span) => span.text.includes(needle)));
}

/** The span whose text is exactly `text`, failing the test when there is none. */
function spanWith(lines: readonly StyledLine[], text: string): Span {
  const span = lines.flat().find((candidate) => candidate.text === text);
  if (span === undefined) {
    throw new Error(`no span ${JSON.stringify(text)} in ${JSON.stringify(texts(lines))}`);
  }
  return span;
}

describe("renderTable", () => {
  test("AC-1: draws a two-column table as a box grid", () => {
    expect(texts(renderBasic())).toEqual([
      "┌─────┬────┐",
      "│ a   │ bb │",
      "├─────┼────┤",
      "│ ccc │ d  │",
      "└─────┴────┘",
    ]);
  });

  test("AC-2: every border and vertical glyph is muted", () => {
    const frame = frameSpans(renderBasic(), UNICODE_THEME.glyphs.table);
    expect(frame.length).toBeGreaterThan(0);
    for (const span of frame) expect(span.color).toBe("muted");
  });

  test("AC-3: the header cells are bold", () => {
    const lines = renderBasic();
    for (const span of spansHolding(lines, "a")) expect(span.bold).toBe(true);
    for (const span of spansHolding(lines, "bb")) expect(span.bold).toBe(true);
  });

  test("AC-4: the body cell is not bold", () => {
    for (const span of spansHolding(renderBasic(), "ccc")) expect(span.bold ?? false).toBe(false);
  });

  test("AC-5: a header cell keeps its own style and gains bold", () => {
    const model = table([[{ text: "hot", color: "accent" }], cell("x")], [[cell("y"), cell("z")]], [null, null]);
    const header = renderTable(model, tableOptions(UNICODE_THEME))[1];
    expect(spanWith([header], "hot")).toEqual({ text: "hot", color: "accent", bold: true });
  });

  test("AC-6: a right-aligned column pads its body cell on the left", () => {
    const model = table([cell("a"), cell("bb")], [[cell("ccc"), cell("d")]], [null, "right"]);
    expect(texts(renderTable(model, tableOptions(UNICODE_THEME)))[3]).toBe("│ ccc │  d │");
  });

  test("AC-7: a centred cell puts the spare column on the left half", () => {
    const model = table([cell("head5")], [[cell("ab")]], ["center"]);
    expect(texts(renderTable(model, tableOptions(UNICODE_THEME)))[3]).toBe("│  ab   │");
  });

  test("AC-8: a left-aligned cell pads on the right", () => {
    const model = table([cell("head5")], [[cell("ab")]], ["left"]);
    expect(texts(renderTable(model, tableOptions(UNICODE_THEME)))[3]).toBe("│ ab    │");
  });

  test("AC-9: a header cell takes its column's alignment", () => {
    const model = table([cell("ab")], [[cell("head5")]], ["right"]);
    expect(texts(renderTable(model, tableOptions(UNICODE_THEME)))[1]).toBe("│    ab │");
  });

  test("AC-10: a wrapped cell keeps the grid square", () => {
    const model = table(
      [cell("Story"), cell("Description")],
      [[cell("US-001"), cell("add the esc layer model")]],
      [null, null],
    );
    expect(texts(renderTable(model, tableOptions(UNICODE_THEME, 25)))).toEqual([
      "┌────────┬──────────────┐",
      "│ Story  │ Description  │",
      "├────────┼──────────────┤",
      "│ US-001 │ add the esc  │",
      "│        │ layer model  │",
      "└────────┴──────────────┘",
    ]);
  });

  test("AC-11: every line is exactly sum(widths) + 3n + 1 columns wide, wide characters included", () => {
    const model = table([cell("a"), cell("日本")], [[cell("bb"), cell("c")]], [null, null]);
    const lines = renderTable(model, tableOptions(UNICODE_THEME));
    expect(texts(lines)).toHaveLength(5);
    expect(texts(lines)[1]).toBe("│ a  │ 日本 │");
    for (const line of lines) expect(spansWidth(line)).toBe(2 + 4 + 3 * 2 + 1);
  });

  test("AC-12: a row with fewer cells than the header draws blank cells", () => {
    const model = table([cell("a"), cell("b")], [[cell("1")]], [null, null]);
    expect(texts(renderTable(model, tableOptions(UNICODE_THEME)))).toEqual([
      "┌───┬───┐",
      "│ a │ b │",
      "├───┼───┤",
      "│ 1 │   │",
      "└───┴───┘",
    ]);
  });

  test("AC-13: a row with more cells than the header draws only the header's count", () => {
    const model = table([cell("a"), cell("b")], [[cell("1"), cell("2"), cell("3")]], [null, null]);
    expect(texts(renderTable(model, tableOptions(UNICODE_THEME)))).toEqual([
      "┌───┬───┐",
      "│ a │ b │",
      "├───┼───┤",
      "│ 1 │ 2 │",
      "└───┴───┘",
    ]);
  });

  test("AC-14: a header-only table draws no separator line", () => {
    const model = table([cell("a"), cell("b")], [], [null, null]);
    expect(texts(renderTable(model, tableOptions(UNICODE_THEME)))).toEqual(["┌───┬───┐", "│ a │ b │", "└───┴───┘"]);
  });

  test("AC-15: an empty header draws nothing", () => {
    expect(renderTable(table([], [[cell("1")]], []), tableOptions(UNICODE_THEME))).toEqual([]);
  });

  test("AC-16: a table squeezed to its floors still draws a grid", () => {
    const model = table(
      [cell("a"), cell("b"), cell("c"), cell("d")],
      [
        [cell("1"), cell("2"), cell("3"), cell("4")],
        [cell("5"), cell("6"), cell("7"), cell("8")],
      ],
      [null, null, null, null],
    );
    const lines = renderTable(model, tableOptions(UNICODE_THEME, 17));
    expect(texts(lines)[0]).toBe("┌───┬───┬───┬───┐");
    for (const line of lines) expect(spansWidth(line)).toBe(1 * 4 + 3 * 4 + 1);
  });

  test("AC-17: the ASCII glyph set draws an ASCII frame", () => {
    expect(texts(renderBasic(ASCII_THEME))).toEqual([
      "+-----+----+",
      "| a   | bb |",
      "+-----+----+",
      "| ccc | d  |",
      "+-----+----+",
    ]);
  });
});
