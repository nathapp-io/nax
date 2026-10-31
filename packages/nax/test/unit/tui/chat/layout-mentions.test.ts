import { describe, expect, test } from "bun:test";
import { userTextSpans } from "@/tui/chat/layout-mentions";
import type { Span } from "@/tui/chat/styled-line";

const WIDTH = 60;
/** Narrow enough that a mention can be split by a wrap or sit at the end of one. */
const NARROW_WIDTH = 10;

/** The rows the message is laid out as, with the columns the layout would leave it. */
function rowsOf(text: string, mentions: readonly string[], columns = WIDTH): readonly (readonly Span[])[] {
  return userTextSpans(text, mentions, columns);
}

/** One row's text, for asserting nothing was lost or added. */
function textOf(spans: readonly Span[]): string {
  return spans.map((span) => span.text).join("");
}

/** The accent spans of one row — the mentions that row highlighted. */
function accentsOf(spans: readonly Span[]): readonly string[] {
  return spans.filter((span) => span.color === "accent").map((span) => span.text);
}

describe("userTextSpans", () => {
  test("styles every whole occurrence of a listed mention", () => {
    const [row] = rowsOf("@a.ts and again @a.ts", ["a.ts"]);
    expect(accentsOf(row)).toEqual(["@a.ts", "@a.ts"]);
    expect(textOf(row)).toBe("@a.ts and again @a.ts");
  });

  test("highlights the exact path listed and leaves a shorter one alone", () => {
    expect(accentsOf(rowsOf("see @a.tsx", ["a.tsx"])[0])).toEqual(["@a.tsx"]);
    expect(accentsOf(rowsOf("see @a.tsx", ["a.ts"])[0])).toEqual([]);
  });

  test("styles several mentions on one row in the order they appear", () => {
    const [row] = rowsOf("see @a.ts and @b.png now", ["b.png", "a.ts"]);
    expect(accentsOf(row)).toEqual(["@a.ts", "@b.png"]);
  });

  test("styles a mention that prose follows with a run of punctuation", () => {
    const [row] = rowsOf("see (@a.ts).", ["a.ts"]);
    expect(accentsOf(row)).toEqual(["@a.ts"]);
    expect(textOf(row)).toBe("see (@a.ts).");
  });

  test("leaves a path that continues after the listed one plain", () => {
    expect(accentsOf(rowsOf("see @a.ts)x", ["a.ts"])[0])).toEqual([]);
  });

  test("styles a mention that a wrap leaves whole at the end of a row", () => {
    const rows = rowsOf("see @a.ts now", ["a.ts"], NARROW_WIDTH);
    expect(rows.map(textOf)).toEqual(["see @a.ts", "now"]);
    expect(accentsOf(rows[0])).toEqual(["@a.ts"]);
  });

  test("leaves a mention a wrap split in two plain in both halves", () => {
    const rows = rowsOf("@abcdefghijklmnop", ["abcdefghijklmnop"], NARROW_WIDTH);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(accentsOf(row)).toEqual([]);
    expect(rows.map(textOf).join("")).toBe("@abcdefghijklmnop");
  });

  test("styles a path carrying whitespace in its quoted form", () => {
    const [row] = rowsOf('open @"my dir/x.ts" please', ["my dir/x.ts"]);
    expect(accentsOf(row)).toEqual(['@"my dir/x.ts"']);
  });

  test("draws a message with no mentions as one plain run per row", () => {
    const rows = rowsOf("see @a.ts now", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([{ text: "see @a.ts now" }]);
  });

  test("keeps a blank source line as an empty row", () => {
    expect(rowsOf("a\n\nb", ["a"])).toEqual([[{ text: "a" }], [], [{ text: "b" }]]);
  });
});
