/**
 * Smart Runner — packagePrefix and co-located test discovery
 *
 * Covers:
 * - Monorepo package scoping (packagePrefix)
 * - Co-located test files via configurable testFilePatterns (language-agnostic)
 *
 * Co-located detection is driven by extractPatternSuffix() — the suffix after
 * the last `*` in each configured glob pattern. Examples:
 *   "src/**\/*.spec.ts"  → probes <sourceFile>.spec.ts  (NestJS)
 *   "**\/*_test.go"      → probes <sourceFile>_test.go   (Go)
 *   "test_*.py"          → no suffix (pattern omitted)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mapSourceToTests } from "../../../src/verification/smart-runner";

function mockFileExists(existingPaths: string[]) {
  // biome-ignore lint/suspicious/noExplicitAny: mocking Bun.file
  (Bun as any).file = (path: string) => ({
    exists: () => Promise.resolve(existingPaths.includes(path)),
  });
}

describe("mapSourceToTests — packagePrefix (monorepo)", () => {
  let originalFile: typeof Bun.file;

  beforeEach(() => {
    originalFile = Bun.file;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    (Bun as any).file = originalFile;
  });

  test("maps monorepo source to package-local test/unit when packagePrefix is set", async () => {
    mockFileExists(["/repo/apps/api/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(
      ["apps/api/src/foo/bar.ts"],
      "/repo",
      "apps/api",
    );

    expect(result).toEqual(["/repo/apps/api/test/unit/foo/bar.test.ts"]);
  });

  test("maps monorepo source to package-local test/integration when packagePrefix is set", async () => {
    mockFileExists(["/repo/apps/api/test/integration/foo/bar.test.ts"]);

    const result = await mapSourceToTests(
      ["apps/api/src/foo/bar.ts"],
      "/repo",
      "apps/api",
    );

    expect(result).toEqual(["/repo/apps/api/test/integration/foo/bar.test.ts"]);
  });

  test("does NOT look in workdir/test/unit when packagePrefix is set", async () => {
    // Only the wrong (root-level) path exists — should not be returned
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(
      ["apps/api/src/foo/bar.ts"],
      "/repo",
      "apps/api",
    );

    expect(result).toEqual([]);
  });

  test("returns empty array when no packagePrefix match exists on disk", async () => {
    mockFileExists([]);

    const result = await mapSourceToTests(
      ["apps/api/src/foo/bar.ts"],
      "/repo",
      "apps/api",
    );

    expect(result).toEqual([]);
  });

  test("single-package behaviour unchanged when packagePrefix is undefined", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(["src/foo/bar.ts"], "/repo", undefined);

    expect(result).toEqual(["/repo/test/unit/foo/bar.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Co-located test files — language-agnostic via testFilePatterns
//
// The suffix after the last `*` in each pattern drives which co-located
// candidates are probed. No suffixes are hardcoded in the source.
// ---------------------------------------------------------------------------

describe("mapSourceToTests — co-located test files (testFilePatterns)", () => {
  let originalFile: typeof Bun.file;

  beforeEach(() => {
    originalFile = Bun.file;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    (Bun as any).file = originalFile;
  });

  test("finds co-located .spec.ts in monorepo src/ when pattern includes src/**/*.spec.ts (NestJS)", async () => {
    mockFileExists(["/repo/apps/api/src/agents/agents.service.spec.ts"]);

    const result = await mapSourceToTests(
      ["apps/api/src/agents/agents.service.ts"],
      "/repo",
      "apps/api",
      ["src/**/*.spec.ts"],
    );

    expect(result).toEqual(["/repo/apps/api/src/agents/agents.service.spec.ts"]);
  });

  test("finds co-located .test.ts in monorepo src/ when pattern includes test/**/*.test.ts (Vitest/Jest)", async () => {
    mockFileExists(["/repo/apps/api/src/agents/agents.service.test.ts"]);

    const result = await mapSourceToTests(
      ["apps/api/src/agents/agents.service.ts"],
      "/repo",
      "apps/api",
      ["test/**/*.test.ts"],
    );

    expect(result).toEqual(["/repo/apps/api/src/agents/agents.service.test.ts"]);
  });

  test("finds co-located .spec.ts in single-package src/ when pattern includes src/**/*.spec.ts", async () => {
    mockFileExists(["/repo/src/utils/helper.spec.ts"]);

    const result = await mapSourceToTests(
      ["src/utils/helper.ts"],
      "/repo",
      undefined,
      ["src/**/*.spec.ts"],
    );

    expect(result).toEqual(["/repo/src/utils/helper.spec.ts"]);
  });

  test("does not find co-located .spec.ts when pattern only includes test/**/*.test.ts", async () => {
    // .spec.ts exists but suffix not covered by the configured pattern
    mockFileExists(["/repo/src/utils/helper.spec.ts"]);

    const result = await mapSourceToTests(
      ["src/utils/helper.ts"],
      "/repo",
      undefined,
      ["test/**/*.test.ts"],
    );

    expect(result).toEqual([]);
  });

  test("returns both separated test/unit/ and co-located .spec.ts when both exist (multi-pattern)", async () => {
    mockFileExists([
      "/repo/apps/api/test/unit/agents/agents.service.test.ts",
      "/repo/apps/api/src/agents/agents.service.spec.ts",
    ]);

    const result = await mapSourceToTests(
      ["apps/api/src/agents/agents.service.ts"],
      "/repo",
      "apps/api",
      ["test/**/*.test.ts", "src/**/*.spec.ts"],
    );

    expect(result).toEqual([
      "/repo/apps/api/test/unit/agents/agents.service.test.ts",
      "/repo/apps/api/src/agents/agents.service.spec.ts",
    ]);
  });

  test("deduplicates suffixes — duplicate patterns produce no duplicate candidates", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(
      ["src/foo/bar.ts"],
      "/repo",
      undefined,
      ["test/**/*.test.ts", "test/unit/**/*.test.ts"], // both yield .test.ts
    );

    // Should not return the same file twice
    expect(result).toEqual(["/repo/test/unit/foo/bar.test.ts"]);
  });
});
