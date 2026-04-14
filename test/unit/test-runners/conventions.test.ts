/**
 * Tests for test-file convention helpers.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TEST_FILE_PATTERNS,
  globsToTestRegex,
  isTestFileByPatterns,
} from "../../../src/test-runners/conventions";

describe("DEFAULT_TEST_FILE_PATTERNS", () => {
  test("is a non-empty frozen list", () => {
    expect(DEFAULT_TEST_FILE_PATTERNS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DEFAULT_TEST_FILE_PATTERNS)).toBe(true);
  });

  test("includes the canonical TS test glob", () => {
    expect(DEFAULT_TEST_FILE_PATTERNS).toContain("test/**/*.test.ts");
  });
});

describe("globsToTestRegex", () => {
  test("extracts .test.ts suffix", () => {
    const [re] = globsToTestRegex(["test/**/*.test.ts"]);
    expect(re).toBeDefined();
    expect(re.test("src/foo.test.ts")).toBe(true);
    expect(re.test("src/foo.ts")).toBe(false);
  });

  test("extracts .spec.ts suffix (NestJS)", () => {
    const [re] = globsToTestRegex(["src/**/*.spec.ts"]);
    expect(re.test("apps/api/src/agents/agents.service.spec.ts")).toBe(true);
    expect(re.test("apps/api/src/agents/agents.service.ts")).toBe(false);
  });

  test("extracts _test.go suffix (Go)", () => {
    const [re] = globsToTestRegex(["**/*_test.go"]);
    expect(re.test("internal/foo/bar_test.go")).toBe(true);
    expect(re.test("internal/foo/bar.go")).toBe(false);
  });

  test("returns multiple regexes for multiple patterns", () => {
    const regexes = globsToTestRegex(["test/**/*.test.ts", "src/**/*.spec.ts"]);
    expect(regexes).toHaveLength(2);
  });

  test("de-duplicates identical suffix regexes", () => {
    const regexes = globsToTestRegex(["test/**/*.test.ts", "test/unit/**/*.test.ts"]);
    expect(regexes).toHaveLength(1);
  });

  test("skips patterns with no `*`", () => {
    const regexes = globsToTestRegex(["no-wildcard.ts"]);
    expect(regexes).toHaveLength(0);
  });

  test("skips patterns with empty trailing suffix", () => {
    const regexes = globsToTestRegex(["test/*"]);
    expect(regexes).toHaveLength(0);
  });

  test("escapes regex metacharacters in suffix", () => {
    const [re] = globsToTestRegex(["**/*.test.ts"]);
    // The `.` in `.test.ts` must be escaped so it doesn't match any char
    expect(re.test("fooXtestXts")).toBe(false);
    expect(re.test("foo.test.ts")).toBe(true);
  });
});

describe("isTestFileByPatterns", () => {
  test("returns true when any configured pattern matches", () => {
    expect(
      isTestFileByPatterns("src/foo.spec.ts", ["test/**/*.test.ts", "src/**/*.spec.ts"]),
    ).toBe(true);
  });

  test("returns false when no pattern matches", () => {
    expect(isTestFileByPatterns("src/foo.ts", ["test/**/*.test.ts"])).toBe(false);
  });

  test("returns false when patterns yield no usable regexes", () => {
    expect(isTestFileByPatterns("src/foo.test.ts", ["no-wildcard.ts"])).toBe(false);
  });
});
