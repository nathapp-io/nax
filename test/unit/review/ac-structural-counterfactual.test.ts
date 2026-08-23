import { describe, expect, test } from "bun:test";
import { BLOCKING_CATEGORIES, analyzeStructuralCounterfactual } from "@/review";

const ACS = ["AC1: validate input", "AC2: error path", "AC3: assumption"];

function diffFiles(...paths: string[]): ReadonlySet<string> {
  return new Set(paths);
}

describe("BLOCKING_CATEGORIES", () => {
  test("contains exactly the four blocking categories", () => {
    expect([...BLOCKING_CATEGORIES].sort()).toEqual(["abandonment", "assumption", "error-path", "input"].sort());
  });
});

describe("analyzeStructuralCounterfactual", () => {
  describe("acIndexInRange", () => {
    test.each([
      [1, true],
      [3, true],
      [0, false],
      [4, false],
      [-1, false],
      [undefined, false],
    ])("acIndex=%p → acIndexInRange=%p", (acIndex, expected) => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: acIndex as number | undefined, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(result.acIndexInRange).toBe(expected);
    });

    test("non-integer acIndex within range → true (spec accepts numeric range, not integer)", () => {
      // Issue #986 spec: `typeof acIndex === "number" && acIndex >= 1 && acIndex <= length`.
      // 1.5 falls in [1, 3] so it is in range. This documents the choice — if the
      // structural alternative ships, integer-only validation would be a separate issue.
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1.5, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(result.acIndexInRange).toBe(true);
    });
  });

  describe("categoryBlocking", () => {
    test.each([
      ["input", true],
      ["error-path", true],
      ["abandonment", true],
      ["assumption", true],
      ["convention", false],
      ["test-gap", false],
      ["unknown-category", false],
      [undefined, false],
    ])("category=%p → categoryBlocking=%p", (category, expected) => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: category as string | undefined, file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(result.categoryBlocking).toBe(expected);
    });
  });

  describe("fileInDiff", () => {
    test("file present in set → true", () => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts", "src/b.ts"),
      );
      expect(result.fileInDiff).toBe(true);
    });

    test("file absent from set → false", () => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/c.ts" },
        ACS,
        diffFiles("src/a.ts", "src/b.ts"),
      );
      expect(result.fileInDiff).toBe(false);
    });

    test("missing file → false", () => {
      const result = analyzeStructuralCounterfactual({ acIndex: 1, category: "input" }, ACS, diffFiles("src/a.ts"));
      expect(result.fileInDiff).toBe(false);
    });

    test("empty diffFiles set (diff unavailable) → fileInDiff=false for every input", () => {
      const result = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/a.ts" },
        ACS,
        new Set(),
      );
      expect(result.fileInDiff).toBe(false);
    });
  });

  describe("wouldSurviveStructural", () => {
    test("all three axes true → true", () => {
      const r = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(r.wouldSurviveStructural).toBe(true);
    });

    test("any axis false → false", () => {
      const r1 = analyzeStructuralCounterfactual(
        { acIndex: 99, category: "input", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(r1.wouldSurviveStructural).toBe(false);

      const r2 = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "convention", file: "src/a.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(r2.wouldSurviveStructural).toBe(false);

      const r3 = analyzeStructuralCounterfactual(
        { acIndex: 1, category: "input", file: "src/missing.ts" },
        ACS,
        diffFiles("src/a.ts"),
      );
      expect(r3.wouldSurviveStructural).toBe(false);
    });
  });
});
