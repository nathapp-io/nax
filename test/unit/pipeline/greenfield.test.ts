// RE-ARCH: keep
/**
 * Tests for src/context/greenfield.ts
 *
 * Covers: isGreenfieldStory
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { isGreenfieldStory } from "@/context/greenfield";
import type { UserStory } from "@/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const createMockStory = (id = "US-001"): UserStory => ({
  id,
  title: "Test story",
  description: "Test description",
  acceptanceCriteria: [],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
});

async function createTestFile(workdir: string, filepath: string, content = ""): Promise<void> {
  const fullPath = join(workdir, filepath);
  await Bun.write(fullPath, content);
}

/**
 * Broad polyglot globs equivalent to what the ADR-009 SSOT resolver's detection
 * tier yields for a repo with co-located tests. Production callers (routing
 * pre-check, greenfieldGateOp) always pass patterns resolved via
 * `resolveTestFilePatterns()`; these exercise the classifier + IGNORE_DIRS logic
 * for co-located-test layouts. With NO patterns, `isGreenfieldStory` falls back
 * to DEFAULT_TEST_FILE_PATTERNS ("test/**\/*.test.ts") — parity with
 * `verifyTestWriterIsolation`.
 */
const BROAD_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.js",
  "**/*.spec.tsx",
  "**/*.spec.jsx",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// isGreenfieldStory
// ─────────────────────────────────────────────────────────────────────────────

describe("isGreenfieldStory", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = makeTempDir("nax-greenfield-test-");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("returns true when no test files exist", async () => {
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(true);
  });

  // Co-located-src layouts: production resolves broad globs via the SSOT detection
  // tier, so these pass BROAD_PATTERNS to exercise the classifier. (With the
  // DEFAULT_TEST_FILE_PATTERNS fallback, src-co-located tests do not match — that
  // is the intended parity with verifyTestWriterIsolation; see default-fallback
  // test below.)
  it("returns false when .test.ts files exist (resolved globs)", async () => {
    await createTestFile(workdir, "src/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(result).toBe(false);
  });

  it("returns false when .spec.ts files exist (resolved globs)", async () => {
    await createTestFile(workdir, "src/foo.spec.ts", "describe('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(result).toBe(false);
  });

  it("returns false when .test.js files exist (resolved globs)", async () => {
    await createTestFile(workdir, "src/foo.test.js", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(result).toBe(false);
  });

  it("returns false when .test.tsx files exist (resolved globs)", async () => {
    await createTestFile(workdir, "src/Component.test.tsx", "test('renders', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(result).toBe(false);
  });

  it("returns false when test files exist in test/ directory (DEFAULT fallback)", async () => {
    // test/**/*.test.ts is the DEFAULT_TEST_FILE_PATTERNS fallback — no patterns needed.
    await createTestFile(workdir, "test/unit/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(false);
  });

  it("falls back to DEFAULT_TEST_FILE_PATTERNS when no patterns supplied (parity with isolation)", async () => {
    // src-co-located test does NOT match the narrow DEFAULT (test/**/*.test.ts).
    // verifyTestWriterIsolation uses the same default, so both agree.
    await createTestFile(workdir, "src/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(true);
  });

  it("ignores test files in node_modules", async () => {
    await createTestFile(workdir, "node_modules/lib/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(result).toBe(true);
  });

  it("ignores test files in dist", async () => {
    await createTestFile(workdir, "dist/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(result).toBe(true);
  });

  it("does not ignore test files in build (build/ is a valid source dir in Go/Rust)", async () => {
    await createTestFile(workdir, "build/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(result).toBe(false);
  });

  it("returns true when only source files exist", async () => {
    await createTestFile(workdir, "src/index.ts", "export const foo = 42;");
    await createTestFile(workdir, "src/utils.ts", "export const bar = 'baz';");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(result).toBe(true);
  });

  it("accepts custom test pattern", async () => {
    await createTestFile(workdir, "src/foo.custom.ts", "test('foo', () => {})");
    const story = createMockStory();

    // Default (and broad) patterns should not match a .custom.ts file
    const resultDefault = await isGreenfieldStory(story, workdir, BROAD_PATTERNS);
    expect(resultDefault).toBe(true);

    // Custom pattern should match
    const resultCustom = await isGreenfieldStory(story, workdir, ["**/*.custom.ts"]);
    expect(resultCustom).toBe(false);
  });

  it("returns false on scan error (safe fallback - don't skip TDD)", async () => {
    const story = createMockStory();
    // Use an invalid workdir to trigger scan error
    const result = await isGreenfieldStory(story, "/nonexistent/path/that/does/not/exist");
    // Should return false (not greenfield) to be safe - don't skip TDD when unsure
    expect(result).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-012 Regression: pre-existing tests should not be treated as greenfield
// ─────────────────────────────────────────────────────────────────────────────

// BUG-012
describe("pre-existing test files prevent false greenfield detection", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = makeTempDir("nax-greenfield-bug012-");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("returns false (not greenfield) when test file was committed before test-writer ran", async () => {
    // Simulate: developer pre-wrote tests and committed them (dogfood scenario)
    await createTestFile(
      workdir,
      "test/unit/commands/unlock.test.ts",
      "import { describe, it, expect } from 'bun:test'; describe('unlock', () => { it('works', () => { expect(true).toBe(true); }); });",
    );

    const story = createMockStory("US-001");
    const result = await isGreenfieldStory(story, workdir);

    // Should NOT be greenfield — pre-existing tests exist
    expect(result).toBe(false);
  });

  it("returns true (greenfield) only when absolutely no test files exist", async () => {
    // Only source files, no tests
    await createTestFile(workdir, "src/commands/unlock.ts", "export function unlockCommand() {}");

    const story = createMockStory("US-001");
    const result = await isGreenfieldStory(story, workdir);

    expect(result).toBe(true);
  });

  it("detects tests with directory-prefixed pattern (e.g. test/**/*.test.ts)", async () => {
    // Regression: scanForTestFiles previously tested entry.name ("foo.test.ts") against
    // path-aware regexes from globsToTestRegex, so "test/**/*.test.ts" never matched
    // because the regex requires the "test/" prefix. With this fix it matches the
    // relative path "test/unit/foo.test.ts" correctly.
    await createTestFile(workdir, "test/unit/foo.test.ts", "test('foo', () => {})");

    const story = createMockStory("US-001");
    const result = await isGreenfieldStory(story, workdir, ["test/**/*.test.ts"]);

    // NOT greenfield — test file exists and the directory-prefixed pattern must match
    expect(result).toBe(false);
  });

  it("does not match test files outside the pattern-specified directory", async () => {
    // A file at src/foo.test.ts should not match test/**/*.test.ts
    await createTestFile(workdir, "src/foo.test.ts", "test('foo', () => {})");

    const story = createMockStory("US-001");
    const result = await isGreenfieldStory(story, workdir, ["test/**/*.test.ts"]);

    // IS greenfield — the file is in src/, not test/, so pattern does not match
    expect(result).toBe(true);
  });
});
