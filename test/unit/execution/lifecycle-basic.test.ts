/**
 * Basic Lifecycle Tests — reverseMapTestToSource
 *
 * Tests for test-to-source file mapping utility.
 * Extracted from lifecycle.test.ts for size management.
 */

import { describe, expect, test } from "bun:test";

describe("reverseMapTestToSource", () => {
  test("should map test/unit files to source files", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/unit/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should map test/integration files to source files", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/integration/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should ignore non-test files", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/src/foo/bar.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });

  test("should deduplicate results", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/unit/foo/bar.test.ts", "/repo/test/integration/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should handle paths without leading workdir", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["test/unit/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should preserve order when mapping multiple files", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = [
      "/repo/test/unit/aaa.test.ts",
      "/repo/test/unit/bbb.test.ts",
      "/repo/test/unit/ccc.test.ts",
    ];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/aaa.ts", "src/bbb.ts", "src/ccc.ts"]);
  });

  test("should handle empty input", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles: string[] = [];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });

  test("should filter out files with .test.js extension", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/unit/foo.js"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });
});
