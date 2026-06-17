import { describe, expect, test } from "bun:test";
import { BLOCKING_CATEGORIES } from "@/review";
import { categoryToFixTarget } from "@/review";

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
      expect(categoryToFixTarget(null as unknown as undefined)).toBe("test");
    });
  });
});