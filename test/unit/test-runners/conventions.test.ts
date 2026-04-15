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
  test("matches files inside the configured test directory", () => {
    const [re] = globsToTestRegex(["test/**/*.test.ts"]);
    expect(re).toBeDefined();
    expect(re.test("test/foo.test.ts")).toBe(true);
    expect(re.test("apps/api/test/integration/foo.test.ts")).toBe(true);
    // Files outside `test/` must NOT match this pattern — broaden the config
    // (e.g. add "**/*.test.ts") to classify co-located tests.
    expect(re.test("src/foo.test.ts")).toBe(false);
    expect(re.test("src/foo.ts")).toBe(false);
  });

  test("matches NestJS spec files via src/**/*.spec.ts", () => {
    const [re] = globsToTestRegex(["src/**/*.spec.ts"]);
    expect(re.test("apps/api/src/agents/agents.service.spec.ts")).toBe(true);
    expect(re.test("apps/api/src/agents/agents.service.ts")).toBe(false);
  });

  test("matches Go test files via **/*_test.go", () => {
    const [re] = globsToTestRegex(["**/*_test.go"]);
    expect(re.test("internal/foo/bar_test.go")).toBe(true);
    expect(re.test("internal/foo/bar.go")).toBe(false);
  });

  test("returns multiple regexes for multiple patterns", () => {
    const regexes = globsToTestRegex(["test/**/*.test.ts", "src/**/*.spec.ts"]);
    expect(regexes).toHaveLength(2);
  });

  test("de-duplicates identical regexes", () => {
    const regexes = globsToTestRegex(["test/**/*.test.ts", "test/**/*.test.ts"]);
    expect(regexes).toHaveLength(1);
  });

  test("preserves directory discriminators in the produced regex", () => {
    const [re] = globsToTestRegex(["**/__tests__/**/*.ts"]);
    expect(re.test("apps/api/__tests__/foo.ts")).toBe(true);
    expect(re.test("src/components/__tests__/button.ts")).toBe(true);
    // Source files outside __tests__ must NOT match — this is the fix for the
    // FEAT-015 over-permissive `.ts$` regex bug.
    expect(re.test("apps/api/src/foo.ts")).toBe(false);
    expect(re.test("src/foo.ts")).toBe(false);
  });

  test("matches literal filename patterns when no `*` is present", () => {
    const [re] = globsToTestRegex(["specific-file.test.ts"]);
    expect(re.test("specific-file.test.ts")).toBe(true);
    expect(re.test("dir/specific-file.test.ts")).toBe(true);
    expect(re.test("other.test.ts")).toBe(false);
  });

  test("skips lone wildcard patterns that would match everything", () => {
    expect(globsToTestRegex(["**"])).toHaveLength(0);
    expect(globsToTestRegex(["*"])).toHaveLength(0);
    expect(globsToTestRegex([""])).toHaveLength(0);
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
