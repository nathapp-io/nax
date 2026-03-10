#!/usr/bin/env bun

/**
 * Test Overlap Analyzer
 *
 * Parses unit and integration tests to identify redundant coverage,
 * partial overlap, and unique integration tests.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { existsSync } from "node:fs";

interface TestInfo {
  path: string;
  describes: string[];
  tests: string[];
  imports: string[];
}

interface OverlapAnalysis {
  redundant: Array<{
    path: string;
    coverage: number;
    unitMatch: string;
  }>;
  partial: Array<{
    path: string;
    coverage: number;
    missingTests: string[];
  }>;
  unique: Array<{
    path: string;
  }>;
}

/**
 * Parse a test file and extract describe blocks, test names, and imports
 */
export function parseTestFile(content: string, filePath: string): TestInfo {
  const describes: string[] = [];
  const tests: string[] = [];
  const imports: Set<string> = new Set();

  // Extract describe blocks: describe("name", () => {})
  const describeRegex = /describe\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = describeRegex.exec(content)) !== null) {
    describes.push(match[1]);
  }

  // Extract test blocks: test("name", () => {}) or it("name", () => {})
  const testRegex = /(?:test|it)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  while ((match = testRegex.exec(content)) !== null) {
    tests.push(match[1]);
  }

  // Extract imports of src modules
  const importRegex = /import\s+.*?\s+from\s+["']([^"']+)["']/g;
  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    // Normalize paths like ../../../../src/config/loader to src/config/loader
    const normalized = importPath.replace(/^\.\.\/*/g, "").replace(/^.*src\//, "src/");
    if (normalized.startsWith("src/")) {
      imports.add(normalized);
    }
  }

  return {
    path: filePath,
    describes,
    tests,
    imports: Array.from(imports),
  };
}

/**
 * Recursively find all test files in a directory
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
 * Parse all test files in unit and integration directories
 */
function parseAllTests(baseDir: string, type: "unit" | "integration"): TestInfo[] {
  const testDir = join(baseDir, "test", type);
  const files = findTestFiles(testDir);

  return files.map((filePath) => {
    const content = readFileSync(filePath, "utf-8");
    const relative_path = relative(baseDir, filePath);
    return parseTestFile(content, relative_path);
  });
}

/**
 * Analyze overlap between unit and integration tests
 */
export function analyzeOverlap(unitTests: TestInfo[], integrationTests: TestInfo[]): OverlapAnalysis {
  const redundant: OverlapAnalysis["redundant"] = [];
  const partial: OverlapAnalysis["partial"] = [];
  const unique: OverlapAnalysis["unique"] = [];

  for (const intTest of integrationTests) {
    // Find unit tests that test the same source modules
    const matchingUnits = unitTests.filter((unit) =>
      intTest.imports.some((imp) => unit.imports.includes(imp))
    );

    if (matchingUnits.length === 0) {
      // No unit tests cover the same modules - it's unique
      unique.push({ path: intTest.path });
    } else {
      // Check coverage level
      const allUnitDescribes = matchingUnits.flatMap((u) => u.describes);
      const intDescribes = intTest.describes;

      // Calculate overlap
      const matchedDescribes = intDescribes.filter((d) => allUnitDescribes.includes(d));
      const coverage = intDescribes.length > 0 ? (matchedDescribes.length / intDescribes.length) * 100 : 0;

      if (coverage === 100) {
        // All describe blocks in integration test are covered by unit tests
        const unitPath = matchingUnits[0].path;
        redundant.push({
          path: intTest.path,
          coverage: 100,
          unitMatch: unitPath,
        });
      } else if (coverage > 0) {
        // Partial coverage
        const missingTests = intDescribes.filter((d) => !allUnitDescribes.includes(d));
        partial.push({
          path: intTest.path,
          coverage: Math.round(coverage),
          missingTests,
        });
      } else {
        // No describe block overlap, but imports match - still unique
        unique.push({ path: intTest.path });
      }
    }
  }

  return { redundant, partial, unique };
}

/**
 * Generate markdown report from overlap analysis
 */
export function generateReport(overlap: OverlapAnalysis): string {
  const lines: string[] = [];

  lines.push("# Test Overlap Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  // Redundant section
  lines.push("## REDUNDANT");
  lines.push("");
  if (overlap.redundant.length === 0) {
    lines.push("No redundant integration tests found.");
  } else {
    lines.push(`Found ${overlap.redundant.length} integration test(s) fully covered by unit tests:`);
    lines.push("");
    for (const test of overlap.redundant) {
      lines.push(`- **${test.path}**`);
      lines.push(`  - Coverage: ${test.coverage}%`);
      lines.push(`  - Unit match: ${test.unitMatch}`);
    }
  }
  lines.push("");

  // Partial section
  lines.push("## PARTIAL");
  lines.push("");
  if (overlap.partial.length === 0) {
    lines.push("No partial overlap found.");
  } else {
    lines.push(`Found ${overlap.partial.length} integration test(s) with partial unit test coverage:`);
    lines.push("");
    for (const test of overlap.partial) {
      lines.push(`- **${test.path}**`);
      lines.push(`  - Coverage: ${test.coverage}%`);
      lines.push(`  - Missing: ${test.missingTests.join(", ")}`);
    }
  }
  lines.push("");

  // Unique section
  lines.push("## UNIQUE");
  lines.push("");
  if (overlap.unique.length === 0) {
    lines.push("No unique integration tests found.");
  } else {
    lines.push(`Found ${overlap.unique.length} unique integration test(s) with no unit test coverage:`);
    lines.push("");
    for (const test of overlap.unique) {
      lines.push(`- ${test.path}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Main function - orchestrates the analysis
 */
async function main() {
  const cwd = process.cwd();

  // Parse all tests
  const unitTests = parseAllTests(cwd, "unit");
  const integrationTests = parseAllTests(cwd, "integration");

  // Analyze overlap
  const overlap = analyzeOverlap(unitTests, integrationTests);

  // Generate and write report
  const report = generateReport(overlap);
  const reportPath = join(cwd, "docs", "test-overlap-report.md");

  // Ensure docs directory exists
  const docsDir = dirname(reportPath);
  if (!existsSync(docsDir)) {
    mkdirSync(docsDir, { recursive: true });
  }

  writeFileSync(reportPath, report);
  console.log(`[OK] Test overlap report written to ${reportPath}`);

  // Summary
  console.log(`\nSummary:`);
  console.log(`- Redundant: ${overlap.redundant.length}`);
  console.log(`- Partial: ${overlap.partial.length}`);
  console.log(`- Unique: ${overlap.unique.length}`);
}

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  process.exit(1);
});
