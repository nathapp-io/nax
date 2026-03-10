#!/usr/bin/env bun

/**
 * Test File Size Checker
 *
 * Scans test/ for files exceeding size limits:
 * - 500 lines: soft limit (warning)
 * - 800 lines: hard limit (exit 1)
 *
 * NAX_SKIP_PRECHECK=1 suppresses hard limit exit
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

interface OversizedFile {
  path: string;
  lineCount: number;
}

/**
 * Count the number of lines in a file
 */
export function countFileLines(filePath: string): number {
  const content = readFileSync(filePath, "utf-8");
  if (!content) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/**
 * Recursively find all .test.ts files in a directory
 */
function findTestFiles(dir: string): string[] {
  const files: string[] = [];

  function traverse(current: string) {
    if (!existsSync(current)) return;

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(fullPath);
      }
    }
  }

  traverse(dir);
  return files;
}

/**
 * Find test files exceeding the soft limit
 */
export function findOversizedTestFiles(
  testDir: string,
  softLimit: number
): OversizedFile[] {
  const testFiles = findTestFiles(testDir);
  const oversized: OversizedFile[] = [];

  for (const filePath of testFiles) {
    const lineCount = countFileLines(filePath);
    if (lineCount > softLimit) {
      oversized.push({
        path: relative(process.cwd(), filePath),
        lineCount,
      });
    }
  }

  // Sort by line count descending
  return oversized.sort((a, b) => b.lineCount - a.lineCount);
}

/**
 * Determine if we should fail on hard limit
 */
export function shouldFailOnHardLimit(
  oversized: OversizedFile[],
  hardLimit: number,
  skipPrecheck: boolean
): boolean {
  if (skipPrecheck) return false;

  return oversized.some((file) => file.lineCount > hardLimit);
}

/**
 * Generate a markdown report of oversized test files
 */
export function generateTestSizesReport(
  oversized: OversizedFile[],
  softLimit: number,
  hardLimit: number
): string {
  const lines: string[] = [];

  lines.push("# Test File Size Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Soft limit: ${softLimit} lines (warning)`);
  lines.push(`Hard limit: ${hardLimit} lines (fail)`);
  lines.push("");

  if (oversized.length === 0) {
    lines.push("✓ All test files are within acceptable size limits!");
    return lines.join("\n");
  }

  lines.push(`Found **${oversized.length}** test file(s) exceeding the soft limit:`);
  lines.push("");

  for (const file of oversized) {
    const isHardLimitExceeded = file.lineCount > hardLimit;
    const indicator = isHardLimitExceeded ? "✗" : "⚠";
    const status = isHardLimitExceeded ? "(HARD LIMIT EXCEEDED)" : "(warning)";
    lines.push(`${indicator} **${file.path}**: ${file.lineCount} lines ${status}`);
  }

  lines.push("");
  lines.push("## Summary");
  lines.push("");

  const hardLimitCount = oversized.filter((f) => f.lineCount > hardLimit).length;
  const totalCount = oversized.length;

  lines.push(`- ${totalCount} test file(s) exceed the soft limit`);
  lines.push(`- ${hardLimitCount} test file(s) exceed the hard limit`);
  lines.push("");
  lines.push("## Recommendations");
  lines.push("");
  lines.push("To reduce test file size, consider:");
  lines.push("- Using `test.each()` to consolidate similar test cases");
  lines.push("- Splitting large test files by describe block");
  lines.push("- Moving setup/helper logic to `test/helpers/`");

  return lines.join("\n");
}

/**
 * Main function
 */
export async function main() {
  const cwd = process.cwd();
  const testDir = join(cwd, "test");
  const softLimit = 500;
  const hardLimit = 800;
  const skipPrecheck = process.env.NAX_SKIP_PRECHECK === "1";

  if (!existsSync(testDir)) {
    console.error("[FAIL] test/ directory not found");
    process.exit(1);
  }

  // Find oversized files
  const oversized = findOversizedTestFiles(testDir, softLimit);

  // Generate report
  const report = generateTestSizesReport(oversized, softLimit, hardLimit);
  console.log(report);

  // Check hard limit
  if (shouldFailOnHardLimit(oversized, hardLimit, skipPrecheck)) {
    console.error("");
    console.error(`[FAIL] One or more test files exceed the hard limit of ${hardLimit} lines`);
    process.exit(1);
  }

  if (oversized.length > 0) {
    console.error("");
    console.error(`[WARN] ${oversized.length} test file(s) exceed the soft limit`);
  } else {
    console.log("");
    console.log("[OK] All test files are within acceptable size limits");
  }
}

// Only run main when this script is directly invoked
if (import.meta.main) {
  main().catch((err) => {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
  });
}
