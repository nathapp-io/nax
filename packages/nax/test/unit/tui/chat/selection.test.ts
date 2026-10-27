import { describe, expect, test } from "bun:test";
import { highlightLine, type Selection, selectedText, transcriptPointAt } from "@/tui/chat/selection";
import { plainText, type StyledLine } from "@/tui/chat/styled-line";

const geometry = { top: 3, height: 10, total: 50, offset: 0, unseen: 0 };
const lines: readonly StyledLine[] = [[{ text: "hello world" }], [{ text: "second line" }]];
const selection: Selection = { anchor: { line: 0, column: 6 }, focus: { line: 1, column: 5 } };
describe("transcriptPointAt", () => {
  test.each([
    ["AC-1", geometry, 5, 4, { line: 40, column: 4 }],
    ["AC-2", geometry, 5, 3, undefined],
    ["AC-3", geometry, 5, 14, undefined],
    ["AC-4", { ...geometry, top: 0, total: 4 }, 1, 1, undefined],
    ["AC-5", { ...geometry, top: 0, total: 4 }, 1, 7, { line: 0, column: 0 }],
    ["AC-6", { ...geometry, unseen: 2 }, 1, 13, undefined],
    ["scrolled", { ...geometry, offset: 3 }, 1, 4, { line: 37, column: 0 }],
    ["short marker", { ...geometry, top: 0, total: 4, unseen: 2 }, 1, 7, { line: 0, column: 0 }],
  ] as const)("%s", (_name, view, x, y, expected) => expect(transcriptPointAt(view, x, y)).toEqual(expected));
});
describe("selectedText", () => {
  test("AC-7 inclusive", () => expect(selectedText(lines, selection)).toBe("world\nsecond"));
  test("AC-8 reversed", () =>
    expect(selectedText(lines, { anchor: selection.focus, focus: selection.anchor })).toBe("world\nsecond"));
  test("AC-9 wide", () =>
    expect(selectedText([[{ text: "a😀b" }]], { anchor: { line: 0, column: 2 }, focus: { line: 0, column: 3 } })).toBe(
      "😀b",
    ));
  test("AC-10 trims", () =>
    expect(
      selectedText([[{ text: "one  " }], [{ text: "two  " }]], {
        anchor: { line: 0, column: 0 },
        focus: { line: 1, column: 9 },
      }),
    ).toBe("one\ntwo"));
  test("cross-span grapheme", () =>
    expect(
      selectedText([[{ text: "a👩" }, { text: "‍💻b" }]], {
        anchor: { line: 0, column: 2 },
        focus: { line: 0, column: 2 },
      }),
    ).toBe("👩‍💻"));
});
describe("highlightLine", () => {
  const line: StyledLine = [{ text: "hello", bold: true, color: "accent" }];
  const range: Selection = { anchor: { line: 0, column: 1 }, focus: { line: 0, column: 3 } };
  test("AC-11 selected style", () =>
    expect(highlightLine(line, 0, range)).toEqual([
      { text: "h", bold: true, color: "accent" },
      { text: "ell", bold: true, color: "accent", inverse: true },
      { text: "o", bold: true, color: "accent" },
    ]));
  test("AC-12 outside columns", () => {
    const result = highlightLine(line, 0, range);
    expect(
      result
        .filter((span) => !span.inverse)
        .map((span) => span.text)
        .join(""),
    ).toBe("ho");
    expect(plainText(result)).toBe("hello");
  });
  test("AC-13 identity", () => expect(highlightLine(line, 1, range)).toBe(line));
  test("cross-span wide highlight", () => {
    const result = highlightLine(
      [
        { text: "a👩", bold: true },
        { text: "‍💻b", italic: true },
      ],
      0,
      { anchor: { line: 0, column: 2 }, focus: { line: 0, column: 1 } },
    );
    expect(result.filter((span) => span.inverse)).toEqual([
      { text: "👩", bold: true, inverse: true },
      { text: "‍💻", italic: true, inverse: true },
    ]);
  });
});
