/**
 * generateMutants — diff-scoped candidate filtering (US-003).
 *
 * Covers AC1–AC6: when `lineRanges` is supplied, only lines inside a range
 * produce mutants; lines outside the ranges are skipped with the same
 * `continue` that already skips comment lines.
 */

import { describe, expect, test } from "bun:test";
import { generateMutants } from "@/verification";

describe("generateMutants — US-003 AC1: lineRanges covering only line 5", () => {
  test("returns mutants only for line 5 when lineRanges is [{ start: 5, end: 5 }]", () => {
    // Five distinct comparison lines — without filtering, all five would mutate.
    const source = `${["a == b", "c == d", "e == f", "g == h", "i == j"].join("\n")}\n`;
    const mutants = generateMutants({
      source,
      language: "typescript",
      file: "x.ts",
      lineRanges: [{ start: 5, end: 5 }],
    });

    expect(mutants.length).toBeGreaterThan(0);
    for (const m of mutants) {
      expect(m.line).toBe(5);
    }
  });
});

describe("generateMutants — US-003 AC2: range start is eligible", () => {
  test("includes a mutant for the start boundary of the range", () => {
    const source = `${["a == b", "c == d", "e == f", "g == h", "i == j"].join("\n")}\n`;
    const mutants = generateMutants({
      source,
      language: "typescript",
      file: "x.ts",
      lineRanges: [{ start: 3, end: 5 }],
    });

    expect(mutants.some((m) => m.line === 3)).toBe(true);
  });
});

describe("generateMutants — US-003 AC3: range end is eligible", () => {
  test("includes a mutant for the end boundary of the range", () => {
    const source = `${["a == b", "c == d", "e == f", "g == h", "i == j"].join("\n")}\n`;
    const mutants = generateMutants({
      source,
      language: "typescript",
      file: "x.ts",
      lineRanges: [{ start: 3, end: 5 }],
    });

    expect(mutants.some((m) => m.line === 5)).toBe(true);
  });
});

describe("generateMutants — US-003 AC4: two disjoint ranges, no mutants in between", () => {
  test("returns mutants from both ranges and none from lines between them", () => {
    const source = `${["a == b", "c == d", "e == f", "g == h", "i == j", "k == l", "m == n"].join("\n")}\n`;
    const mutants = generateMutants({
      source,
      language: "typescript",
      file: "x.ts",
      lineRanges: [
        { start: 1, end: 2 },
        { start: 6, end: 7 },
      ],
    });

    const lines = new Set(mutants.map((m) => m.line));
    // Lines 1 and 2 (first range) and 6 and 7 (second range) are eligible.
    expect(lines.has(1)).toBe(true);
    expect(lines.has(2)).toBe(true);
    expect(lines.has(6)).toBe(true);
    expect(lines.has(7)).toBe(true);
    // Lines 3, 4, 5 are between the two ranges — must not appear.
    expect(lines.has(3)).toBe(false);
    expect(lines.has(4)).toBe(false);
    expect(lines.has(5)).toBe(false);
  });
});

describe("generateMutants — US-003 AC5: omitted lineRanges preserves whole-file behaviour", () => {
  test("without lineRanges, returns mutants for every mutable source line", () => {
    const source = `${["a == b", "c == d", "e == f", "g == h", "i == j"].join("\n")}\n`;
    const mutants = generateMutants({
      source,
      language: "typescript",
      file: "x.ts",
    });

    const lines = new Set(mutants.map((m) => m.line));
    expect(lines.size).toBe(5);
    for (const ln of [1, 2, 3, 4, 5]) {
      expect(lines.has(ln)).toBe(true);
    }
  });
});

describe("generateMutants — US-003 AC6: empty lineRanges array yields no mutants", () => {
  test("with lineRanges = [] returns empty array even when source has mutable lines", () => {
    const source = `${["a == b", "c == d", "e == f"].join("\n")}\n`;
    const mutants = generateMutants({
      source,
      language: "typescript",
      file: "x.ts",
      lineRanges: [],
    });

    expect(mutants).toEqual([]);
  });
});
