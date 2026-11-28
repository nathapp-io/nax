import { describe, expect, test } from "bun:test";
import { displayWidth, plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import {
  cutSpans,
  elideSpansEnd,
  headColumns,
  MAX_CLUSTER_CODE_UNITS,
  markSpansEnd,
  mergeSpans,
  spansWidth,
  wrap,
  wrapSpans,
} from "@/tui/chat/wrap";

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

describe("headColumns", () => {
  test("keeps the columns that fit and reports the text left behind", () => {
    expect(headColumns("abcdef", 3)).toEqual({ text: "abc", more: true });
  });

  test("keeps a whole text that fits without reporting more", () => {
    expect(headColumns("abc", 3)).toEqual({ text: "abc", more: false });
    expect(headColumns("", 5)).toEqual({ text: "", more: false });
  });

  test("cuts between clusters rather than inside one", () => {
    expect(headColumns("a\u0301b\u0301c\u0301", 2)).toEqual({ text: "a\u0301b\u0301", more: true });
    expect(headColumns("👍👍👍", 2)).toEqual({ text: "👍", more: true });
  });

  test("widens its window for a cluster wider than one code unit per column", () => {
    // Two code units hold one cluster here, so a `columns + 1` window underfills and grows.
    const combining = "a\u0301".repeat(500);
    const head = headColumns(combining, 40);
    expect(displayWidth(head.text)).toBe(40);
    expect(head.more).toBe(true);
  });

  test("keeps nothing for a budget of no columns, and still reports the text", () => {
    expect(headColumns("abc", 0)).toEqual({ text: "", more: true });
  });

  test("US-007 F2: an oversized cluster is cut at a code-unit budget, not scanned to the line's end", () => {
    // One grapheme of a single column: a base character and 4 MiB of combining marks.
    const oversized = `a${"\u0301".repeat(4 * 1024 * 1024)}`;
    const head = headColumns(oversized, 40);
    expect(head.text.length).toBeLessThanOrEqual(40 * MAX_CLUSTER_CODE_UNITS + 1);
    expect(head.more).toBe(true);
    expect(displayWidth(head.text)).toBeLessThanOrEqual(40);
  });

  test("US-007 F2: a cluster under the code-unit cap survives whole, with the text past it reported", () => {
    const cluster = `a${"\u0301".repeat(40 * MAX_CLUSTER_CODE_UNITS - 1)}`;
    const head = headColumns(`${cluster}bc`, 40);
    expect(head.more).toBe(true);
    expect(head.text.startsWith(cluster)).toBe(true);
    expect(head.text.length).toBeLessThanOrEqual(40 * MAX_CLUSTER_CODE_UNITS + 1);
  });

  test("US-007 B4: a cap that lands between the halves of a surrogate pair keeps no lone surrogate", () => {
    // One grapheme of zero-width combining marks ending in supplementary ones: the column budget
    // is never reached, so the code-unit cap decides the cut — and it lands inside a pair.
    const oversized = `${"\u0301".repeat(32)}${"\u{1D165}".repeat(16)}`;

    const head = headColumns(oversized, 4);

    expect(head.more).toBe(true);
    // Half a character is not text: a terminal draws it as a replacement glyph, and the row it
    // is measured in then disagrees with the row drawn.
    expect(LONE_SURROGATE.test(head.text)).toBe(false);
    // The half-pair is dropped rather than kept, so what remains is whole characters.
    expect(head.text).toBe("\u0301".repeat(32));
  });

  test("US-007 B4: the head of a text that ends on a lone surrogate is left alone", () => {
    // The guard is for a pair the WINDOW cut in two, never for text that already holds half a
    // character: an unpaired surrogate the caller supplied still measures as what it is.
    const malformed = `${"\u0301".repeat(32)}\uD834`;

    expect(LONE_SURROGATE.test(headColumns(malformed, 4).text)).toBe(true);
  });
});

/** Any unpaired surrogate: a code unit of a pair whose other half was cut away. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("elideSpansEnd", () => {
  const marker: Span = { text: "…", color: "muted" };

  test("keeps a line that already fits, without a marker", () => {
    expect(textOf(elideSpansEnd([{ text: "abc" }], 10, marker))).toBe("abc");
  });

  test("reserves the marker's columns and drops the blank columns the cut leaves behind", () => {
    const elided = elideSpansEnd([{ text: "abc " }, { text: "def" }], 5, marker);
    expect(textOf(elided)).toBe("abc…");
    expect(elided.at(-1)).toEqual(marker);
  });

  test("cuts a marker wider than the whole line to the line", () => {
    const ascii: Span = { text: "...", color: "muted" };
    expect(textOf(elideSpansEnd([{ text: "abcdef" }], 2, ascii))).toBe("..");
  });

  test("keeps the styles of the clusters it keeps", () => {
    const elided = elideSpansEnd([{ text: "abc", bold: true }, { text: "def" }], 5, marker);
    expect(elided[0].bold).toBe(true);
    expect(textOf(elided)).toBe("abcd…");
  });
});

describe("markSpansEnd", () => {
  const marker: Span = { text: "…", color: "muted" };

  test("marks a line that already fits, where elideSpansEnd keeps it plain", () => {
    expect(textOf(elideSpansEnd([{ text: "abc" }], 5, marker))).toBe("abc");
    expect(textOf(markSpansEnd([{ text: "abc" }], 5, marker))).toBe("abc…");
  });

  test("reserves the marker's columns out of a line that fills the width", () => {
    expect(textOf(markSpansEnd([{ text: "abcde" }], 5, marker))).toBe("abcd…");
  });

  test("cuts a marker wider than the whole line to the line", () => {
    const ascii: Span = { text: "..." };
    expect(textOf(markSpansEnd([{ text: "abcdef" }], 2, ascii))).toBe("..");
  });
});

describe("mergeSpans", () => {
  test("drops empty spans and merges neighbours that share a style", () => {
    const merged = mergeSpans([{ text: "a" }, { text: "" }, { text: "b" }, { text: "c", bold: true }]);
    expect(merged.map((span) => span.text)).toEqual(["ab", "c"]);
  });

  test("merges neighbours that share an underline and keeps it apart from a plain one", () => {
    const merged = mergeSpans([{ text: "1 ", underline: true }, { text: "shell", underline: true }, { text: " x" }]);
    expect(merged).toEqual([{ text: "1 shell", underline: true }, { text: " x" }]);
  });
});

describe("wrap", () => {
  test("draws the prefix on the first line and the same indent on the rest", () => {
    const lines = wrap(mixedSpans(), WIDTH, [{ text: "  " }]);
    expect(textOf(lines[0]).startsWith("  alpha")).toBe(true);
    expect(textOf(lines[1]).startsWith("  ")).toBe(true);
  });

  test("carries an underline through a wrap and a cut", () => {
    const strip: readonly Span[] = [{ text: "3 active (ctrl+g) · $0.42", underline: true, color: "accent" }];
    const lines = wrap(strip, 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      for (const span of line) {
        if (span.text.trim() === "") continue;
        expect({ color: span.color, underline: span.underline }).toEqual({ color: "accent", underline: true });
      }
    }
    expect(cutSpans(strip, 8).every((span) => span.underline === true)).toBe(true);
  });
});

/**
 * A bold `👍` whose skin-tone modifier the inline renderer put in a plain span — the shape
 * `**👍**🏽` produces, and the one a per-span width sum counts twice.
 */
const SPLIT_EMOJI: readonly Span[] = [{ text: "👍", bold: true }, { text: "🏽" }];

describe("spansWidth", () => {
  test("counts a grapheme a style boundary splits once, as the terminal draws it", () => {
    expect(spansWidth(SPLIT_EMOJI)).toBe(displayWidth("👍🏽"));
  });

  test("measures split spans exactly as the same text in one span", () => {
    expect(spansWidth(SPLIT_EMOJI)).toBe(spansWidth([{ text: "👍🏽" }]));
  });

  test("measures a split cluster once wherever it sits in the line", () => {
    const line: readonly Span[] = [{ text: "a " }, ...SPLIT_EMOJI, { text: " b" }];
    expect(spansWidth(line)).toBe(displayWidth("a 👍🏽 b"));
  });

  test("adds up the spans of a line with no split cluster", () => {
    expect(spansWidth(mixedSpans())).toBe(displayWidth(textOf(mixedSpans())));
  });

  test("agrees with wrap on every line wrap drew, so a padded line keeps its frame", () => {
    const line: readonly Span[] = [{ text: "a " }, ...SPLIT_EMOJI, { text: " b" }];
    const lines = wrap(line, 4);
    expect(lines.length).toBeGreaterThan(1);
    for (const wrapped of lines) expect(spansWidth(wrapped)).toBeLessThanOrEqual(4);
  });

  test("keeps a split cluster whole when cutSpans is asked for the room it already takes", () => {
    expect(textOf(cutSpans(SPLIT_EMOJI, 2))).toBe("👍🏽");
  });
});
