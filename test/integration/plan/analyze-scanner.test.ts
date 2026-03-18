// RE-ARCH: keep
/**
 * Tests for Codebase Scanner
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodebaseScan } from "../../../src/analyze/types";
import { scanCodebase } from "../../../src/analyze/scanner";

describe("scanCodebase", () => {
  // Shared scan result for tests that all use the same nax repo root.
  // beforeAll runs scanCodebase once instead of once-per-test (was ~10s × 5 = 50s).
  let rootScan: CodebaseScan;
  const rootWorkdir = join(import.meta.dir, "../../..");

  beforeAll(async () => {
    rootScan = await scanCodebase(rootWorkdir);
  }, 30000);

  test("scans project codebase successfully", async () => {
    // Use the nax test/ directory as test data (smaller scope, independent scan)
    const workdir = join(import.meta.dir, "../..");

    const scan = await scanCodebase(workdir);

    // Should have file tree
    expect(scan.fileTree).toBeTruthy();
    expect(typeof scan.fileTree).toBe("string");
    expect(scan.fileTree.length).toBeGreaterThan(0);

    // Should have dependencies
    expect(scan.dependencies).toBeDefined();
    expect(typeof scan.dependencies).toBe("object");

    // Should have dev dependencies
    expect(scan.devDependencies).toBeDefined();
    expect(typeof scan.devDependencies).toBe("object");

    // Should detect test patterns
    expect(scan.testPatterns).toBeDefined();
    expect(Array.isArray(scan.testPatterns)).toBe(true);
    expect(scan.testPatterns.length).toBeGreaterThan(0);
  });

  test("handles missing src directory", async () => {
    const workdir = `/tmp/nax-test-no-src-${randomUUID()}`;

    // Create temp dir without src/
    await Bun.write(join(workdir, "package.json"), JSON.stringify({}));

    const scan = await scanCodebase(workdir);

    // Should return placeholder for missing src
    expect(scan.fileTree).toBe("No src/ directory");
    expect(scan.dependencies).toEqual({});
    expect(scan.devDependencies).toEqual({});
  });

  test("extracts dependencies from package.json", () => {
    // Should have zod dependency (from real package.json)
    expect(rootScan.dependencies.zod).toBeTruthy();
    expect(rootScan.dependencies.commander).toBeTruthy();
  });

  test("detects test framework", () => {
    // Should detect bun:test (no framework in package.json)
    const hasBunTest = rootScan.testPatterns.some((p) => p.includes("bun:test"));
    expect(hasBunTest).toBe(true);
  });

  test("detects test directory", () => {
    // Should detect test/ directory
    const hasTestDir = rootScan.testPatterns.some((p) => p.includes("test/"));
    expect(hasTestDir).toBe(true);
  });

  test("file tree respects max depth", () => {
    // File tree should not be excessively deep (max depth 3)
    const lines = rootScan.fileTree.split("\n");
    const maxIndent = Math.max(
      ...lines.map((line) => {
        const match = line.match(/^(│ {3}| {4})*/);
        return match ? match[0].length / 4 : 0;
      }),
    );

    // Max depth 3 means max indent of 2 (0-indexed)
    expect(maxIndent).toBeLessThanOrEqual(3);
  });

  test("file tree includes directories and files", () => {
    // Should contain directories (marked with trailing /)
    const hasDirectories = rootScan.fileTree.includes("/");
    expect(hasDirectories).toBe(true);

    // Should contain some TypeScript files
    const hasTsFiles = rootScan.fileTree.includes(".ts");
    expect(hasTsFiles).toBe(true);
  });
});
