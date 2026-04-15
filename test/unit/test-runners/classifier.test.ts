/**
 * Tests for createTestFileClassifier (ADR-009).
 */

import { describe, expect, test } from "bun:test";
import { createTestFileClassifier } from "../../../src/test-runners/classifier";
import type { ResolvedTestPatterns } from "../../../src/test-runners/resolver";

function makeResolved(override: Partial<ResolvedTestPatterns> = {}): ResolvedTestPatterns {
  return {
    globs: ["test/**/*.test.ts"],
    pathspec: [":!*.test.ts"],
    regex: [/\.test\.ts$/],
    testDirs: ["test"],
    resolution: "fallback",
    ...override,
  };
}

describe("createTestFileClassifier", () => {
  test("returns false for non-test path", () => {
    const isTest = createTestFileClassifier(makeResolved());
    expect(isTest("src/foo.ts")).toBe(false);
  });

  test("returns true for matching test path", () => {
    const isTest = createTestFileClassifier(makeResolved());
    expect(isTest("test/unit/foo.test.ts")).toBe(true);
  });

  test("returns true when any regex matches (multiple patterns)", () => {
    const isTest = createTestFileClassifier(
      makeResolved({ regex: [/\.test\.ts$/, /\.spec\.ts$/] }),
    );
    expect(isTest("src/foo.spec.ts")).toBe(true);
    expect(isTest("src/foo.test.ts")).toBe(true);
    expect(isTest("src/foo.ts")).toBe(false);
  });

  test("always returns false when regex list is empty", () => {
    const isTest = createTestFileClassifier(makeResolved({ regex: [] }));
    expect(isTest("test/unit/foo.test.ts")).toBe(false);
    expect(isTest("anything.spec.ts")).toBe(false);
  });

  test("returned classifier is reusable across multiple calls", () => {
    const isTest = createTestFileClassifier(makeResolved());
    expect(isTest("test/a.test.ts")).toBe(true);
    expect(isTest("test/a.test.ts")).toBe(true); // second call same result
    expect(isTest("src/b.ts")).toBe(false);
  });

  test("classifier can be used directly as a filter predicate", () => {
    const isTest = createTestFileClassifier(makeResolved());
    const files = ["src/a.ts", "test/b.test.ts", "src/c.ts", "test/d.test.ts"];
    expect(files.filter(isTest)).toEqual(["test/b.test.ts", "test/d.test.ts"]);
  });
});
