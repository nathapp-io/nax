import { describe, expect, test } from "bun:test";
import { columnWidths, MIN_CELL_WIDTH } from "@/tui/chat/markdown-table";

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
