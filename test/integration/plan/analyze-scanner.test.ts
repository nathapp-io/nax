// RE-ARCH: keep
/**
 * Tests for Codebase Scanner
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scanCodebase } from "../../../src/analyze/scanner";

describe("scanCodebase", () => {
  test("scans project codebase successfully", async () => {
    // Use the nax project itself as test data
    const workdir = join(import.meta.dir, "..");

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
    const workdir = "/tmp/nax-test-no-src";

    // Create temp dir without src/
    await Bun.write(join(workdir, "package.json"), JSON.stringify({}));

    const scan = await scanCodebase(workdir);

    // Should return placeholder for missing src
    expect(scan.fileTree).toBe("No src/ directory");
    expect(scan.dependencies).toEqual({});
    expect(scan.devDependencies).toEqual({});
  });

  test(
    "extracts dependencies from package.json",
    async () => {
      const workdir = join(import.meta.dir, "../..");

      const scan = await scanCodebase(workdir);

      // Should have zod dependency (from real package.json)
      expect(scan.dependencies.zod).toBeTruthy();
      expect(scan.dependencies.commander).toBeTruthy();
    },
    30000,
  );

  test(
    "detects test framework",
    async () => {
      const workdir = join(import.meta.dir, "../..");

      const scan = await scanCodebase(workdir);

      // Should detect bun:test (no framework in package.json)
      const hasBunTest = scan.testPatterns.some((p) => p.includes("bun:test"));
      expect(hasBunTest).toBe(true);
    },
    30000,
  );

  test(
    "detects test directory",
    async () => {
      const workdir = join(import.meta.dir, "../..");

      const scan = await scanCodebase(workdir);

      // Should detect test/ directory
      const hasTestDir = scan.testPatterns.some((p) => p.includes("test/"));
      expect(hasTestDir).toBe(true);
    },
    30000,
  );

  test(
    "file tree respects max depth",
    async () => {
      const workdir = join(import.meta.dir, "../..");

      const scan = await scanCodebase(workdir);

      // File tree should not be excessively deep (max depth 3)
      const lines = scan.fileTree.split("\n");
      const maxIndent = Math.max(
        ...lines.map((line) => {
          const match = line.match(/^(│ {3}| {4})*/);
          return match ? match[0].length / 4 : 0;
        }),
      );

      // Max depth 3 means max indent of 2 (0-indexed)
      expect(maxIndent).toBeLessThanOrEqual(3);
    },
    30000,
  );

  test(
    "file tree includes directories and files",
    async () => {
      const workdir = join(import.meta.dir, "../..");

      const scan = await scanCodebase(workdir);

      // Should contain directories (marked with trailing /)
      const hasDirectories = scan.fileTree.includes("/");
      expect(hasDirectories).toBe(true);

      // Should contain some TypeScript files
      const hasTsFiles = scan.fileTree.includes(".ts");
      expect(hasTsFiles).toBe(true);
    },
    30000,
  );
});
