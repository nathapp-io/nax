import { describe, expect, test } from "bun:test";
import { BLOCKING_CATEGORIES } from "@/review";
import { categoryToFixTarget, resolveFixTarget } from "@/review";

describe("categoryToFixTarget", () => {
  describe("BLOCKING_CATEGORIES members return source", () => {
    test.each([...BLOCKING_CATEGORIES])("categoryToFixTarget(%p) returns source", (category) => {
      expect(categoryToFixTarget(category)).toBe("source");
    });
  });

  describe('"test-gap" returns test', () => {
    test('categoryToFixTarget("test-gap") returns test', () => {
      expect(categoryToFixTarget("test-gap")).toBe("test");
    });
  });

  describe('"convention" returns test', () => {
    test('categoryToFixTarget("convention") returns test', () => {
      expect(categoryToFixTarget("convention")).toBe("test");
    });
  });

  describe("unrecognized categories return test", () => {
    test('categoryToFixTarget("some-unrecognized-category") returns test', () => {
      expect(categoryToFixTarget("some-unrecognized-category")).toBe("test");
    });

    test("categoryToFixTarget(undefined) returns test", () => {
      expect(categoryToFixTarget(undefined)).toBe("test");
    });

    test("categoryToFixTarget(null) returns test", () => {
      expect(categoryToFixTarget(null)).toBe("test");
    });
  });
});

describe("resolveFixTarget — path beats category (#1368)", () => {
  const isTestFile = (path: string) => /\.spec\.ts$/.test(path);

  test("a source-lane base on a test file is overridden to test", () => {
    expect(resolveFixTarget({ base: "source", file: "test/app.module.spec.ts", isTestFile })).toBe("test");
  });

  test("a source-lane base on a source file keeps source", () => {
    expect(resolveFixTarget({ base: "source", file: "src/app.module.ts", isTestFile })).toBe("source");
  });

  test("a test-lane base on a source file is never promoted to source", () => {
    expect(resolveFixTarget({ base: "test", file: "src/app.module.ts", isTestFile })).toBe("test");
  });

  describe("degrades to the base lane when it cannot classify", () => {
    test("no classifier supplied", () => {
      expect(resolveFixTarget({ base: "source", file: "test/app.module.spec.ts" })).toBe("source");
    });

    test("classifier matches nothing (empty configured patterns)", () => {
      expect(resolveFixTarget({ base: "source", file: "test/app.module.spec.ts", isTestFile: () => false })).toBe(
        "source",
      );
    });

    test("finding carries no file", () => {
      expect(resolveFixTarget({ base: "source", isTestFile })).toBe("source");
    });

    test("finding carries an empty file", () => {
      expect(resolveFixTarget({ base: "source", file: "", isTestFile })).toBe("source");
    });
  });

  test("composes with categoryToFixTarget: a blocking category in a test file routes to the test lane", () => {
    // The redis-seams US-002 case: an `abandonment` finding (TestingModule leak)
    // located in a test file must not reach the implementer.
    const base = categoryToFixTarget("abandonment");
    expect(base).toBe("source");
    expect(resolveFixTarget({ base, file: "test/app.module.redis-seams.spec.ts", isTestFile })).toBe("test");
  });
});
