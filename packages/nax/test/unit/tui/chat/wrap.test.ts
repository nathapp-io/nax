import { describe, expect, test } from "bun:test";
import { displayWidth, plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import { cutSpans, mergeSpans, wrap, wrapSpans } from "@/tui/chat/wrap";

const STAR = "* ";
const WIDTH = 12;

/** The line's text with every style dropped. */
function textOf(line: StyledLine): string {
  return plainText(line);
}

/** A bold word followed by plain words, wide enough to need a wrap at `WIDTH`. */
function mixedSpans(): readonly Span[] {
  return [{ text: "alpha ", bold: true }, { text: "beta gamma delta" }];
}

describe("wrapSpans", () => {
  test("retains inverse without merging selected and plain neighbours", () => {
    const spans: StyledLine = [{ text: "selected", inverse: true }, { text: "plain" }];
    expect(mergeSpans(spans)).toEqual(spans);
    const result = wrapSpans(spans, { width: 40 }).flat();
    expect(
      result
        .filter((span) => span.inverse)
        .map((span) => span.text)
        .join(""),
    ).toBe("selected");
    expect(
      result
        .filter((span) => !span.inverse)
        .map((span) => span.text)
        .join(""),
    ).toBe("plain");
  });
  test("wraps already-styled spans to the width behind the prefix", () => {
    const lines = wrapSpans(mixedSpans(), { width: WIDTH, prefix: [{ text: STAR }] });
    for (const line of lines) expect(displayWidth(textOf(line))).toBeLessThanOrEqual(WIDTH);
    expect(textOf(lines[0]).startsWith(`${STAR}alpha`)).toBe(true);
    expect(lines.length).toBeGreaterThan(1);
  });

  test("carries every span's style through the wrap", () => {
    const lines = wrapSpans(mixedSpans(), { width: WIDTH, prefix: [{ text: STAR }] });
    expect(lines.flat().some((span) => span.bold === true)).toBe(true);
    expect(textOf(lines.flat())).toContain("delta");
  });

  test("treats a width below the minimum as the minimum", () => {
    const tiny = wrapSpans(mixedSpans(), { width: 1 });
    const minimum = wrapSpans(mixedSpans(), { width: 10 });
    expect(tiny.map(textOf)).toEqual(minimum.map(textOf));
  });
});

describe("cutSpans", () => {
  test("keeps a line that already fits as it is", () => {
    const spans: readonly Span[] = [{ text: "abc" }];
    expect(textOf(cutSpans(spans, 10))).toBe("abc");
  });

  test("drops whole clusters past the columns and keeps the styles before them", () => {
    const spans: readonly Span[] = [{ text: "abc", bold: true }, { text: "def" }];
    const cut = cutSpans(spans, 4);
    expect(textOf(cut)).toBe("abcd");
    expect(cut[0].bold).toBe(true);
  });
});

describe("mergeSpans", () => {
  test("drops empty spans and merges neighbours that share a style", () => {
    const merged = mergeSpans([{ text: "a" }, { text: "" }, { text: "b" }, { text: "c", bold: true }]);
    expect(merged.map((span) => span.text)).toEqual(["ab", "c"]);
  });
});

describe("wrap", () => {
  test("draws the prefix on the first line and the same indent on the rest", () => {
    const lines = wrap(mixedSpans(), WIDTH, [{ text: "  " }]);
    expect(textOf(lines[0]).startsWith("  alpha")).toBe(true);
    expect(textOf(lines[1]).startsWith("  ")).toBe(true);
  });
});
