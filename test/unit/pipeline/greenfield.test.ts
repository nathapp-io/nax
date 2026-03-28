// RE-ARCH: keep
/**
 * Tests for src/context/greenfield.ts
 *
 * Covers: isGreenfieldStory
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGreenfieldStory } from "../../../src/context/greenfield";
import type { UserStory } from "../../../src/prd/types";
import { makeTempDir } from "../../helpers/temp";

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
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await Bun.write(fullPath, content);
}

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

  it("returns false when .test.ts files exist", async () => {
    await createTestFile(workdir, "src/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(false);
  });

  it("returns false when .spec.ts files exist", async () => {
    await createTestFile(workdir, "src/foo.spec.ts", "describe('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(false);
  });

  it("returns false when .test.js files exist", async () => {
    await createTestFile(workdir, "src/foo.test.js", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(false);
  });

  it("returns false when .test.tsx files exist", async () => {
    await createTestFile(workdir, "src/Component.test.tsx", "test('renders', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(false);
  });

  it("returns false when test files exist in test/ directory", async () => {
    await createTestFile(workdir, "test/unit/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(false);
  });

  it("ignores test files in node_modules", async () => {
    await createTestFile(workdir, "node_modules/lib/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(true);
  });

  it("ignores test files in dist", async () => {
    await createTestFile(workdir, "dist/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(true);
  });

  it("ignores test files in build", async () => {
    await createTestFile(workdir, "build/foo.test.ts", "test('foo', () => {})");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(true);
  });

  it("returns true when only source files exist", async () => {
    await createTestFile(workdir, "src/index.ts", "export const foo = 42;");
    await createTestFile(workdir, "src/utils.ts", "export const bar = 'baz';");
    const story = createMockStory();
    const result = await isGreenfieldStory(story, workdir);
    expect(result).toBe(true);
  });

  it("accepts custom test pattern", async () => {
    await createTestFile(workdir, "src/foo.custom.ts", "test('foo', () => {})");
    const story = createMockStory();

    // Default pattern should not match
    const resultDefault = await isGreenfieldStory(story, workdir);
    expect(resultDefault).toBe(true);

    // Custom pattern should match
    const resultCustom = await isGreenfieldStory(story, workdir, "**/*.custom.ts");
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
});
