#!/usr/bin/env bun

/**
 * Dead Tests Detector
 *
 * Scans test files for broken src/ imports and references to removed features.
 * Generates a report listing test files that need cleanup.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";

interface TestInfo {
  path: string;
  imports: string[];
  testNames: string[];
  describes: string[];
  deadImports?: string[];
  deadReferences?: string[];
}

// Features that have been removed from the codebase
const REMOVED_FEATURES = [
  "worktree",
  "dispatcher",
  "tdd-orchestrator-prompts",
  "verification v0.21",
  "verification v0.22.0",
  "pre-v0.22.1",
];

/**
 * Parse a test file and extract imports, test names, and describe blocks
 */
export function parseTestFile(content: string, filePath: string): TestInfo {
  const imports: Set<string> = new Set();
  const testNames: string[] = [];
  const describes: string[] = [];

  // Extract imports: import ... from "path"
  const importRegex = /import\s+.*?\s+from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    // Skip non-src imports
    if (!importPath.startsWith("src/") && !importPath.includes("/src/")) {
      continue;
    }
    // Normalize paths like ../../../../src/config/loader to src/config/loader
    const normalized = importPath
      .replace(/^\.\.\/*/g, "")
      .replace(/^.*src\//, "src/");

    if (normalized.startsWith("src/")) {
      imports.add(normalized);
    }
  }

  // Extract describe blocks: describe("name", ...)
  const describeRegex = /describe\s*\(\s*["'`]([^"'`]+)["'`]/g;
  while ((match = describeRegex.exec(content)) !== null) {
    describes.push(match[1]);
  }

  // Extract test blocks: test("name", ...) or it("name", ...)
  const testRegex = /(?:test|it)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  while ((match = testRegex.exec(content)) !== null) {
    testNames.push(match[1]);
  }

  return {
    path: filePath,
    imports: Array.from(imports),
    testNames,
    describes,
  };
}

/**
 * Check if an import path exists on disk (handles both .ts and .tsx variants)
 */
function importExists(importPath: string, baseDir: string): boolean {
  // Try with .ts
  const tsPath = join(baseDir, `${importPath}.ts`);
  if (existsSync(tsPath)) return true;

  // Try with .tsx
  const tsxPath = join(baseDir, `${importPath}.tsx`);
  if (existsSync(tsxPath)) return true;

  // Try as directory with index.ts
  const indexPath = join(baseDir, importPath, "index.ts");
  if (existsSync(indexPath)) return true;

  // Try as directory with index.tsx
  const indexTsxPath = join(baseDir, importPath, "index.tsx");
  if (existsSync(indexTsxPath)) return true;

  return false;
}

/**
 * Find imports that don't exist on disk
 */
export function findDeadImports(testInfo: TestInfo, baseDir: string): string[] {
  const dead: string[] = [];

  for (const imp of testInfo.imports) {
    if (!importExists(imp, baseDir)) {
      dead.push(imp);
    }
  }

  return dead;
}

/**
 * Find test names and describe blocks that reference removed features
 */
export function findDeadTestReferences(testInfo: TestInfo): string[] {
  const dead: string[] = [];

  const allText = [...testInfo.testNames, ...testInfo.describes].join(" ");

  for (const feature of REMOVED_FEATURES) {
    if (allText.toLowerCase().includes(feature.toLowerCase())) {
      // Find which specific name contains it
      for (const name of testInfo.testNames) {
        if (name.toLowerCase().includes(feature.toLowerCase())) {
          dead.push(feature);
          break;
        }
      }
      if (!dead.includes(feature)) {
        for (const desc of testInfo.describes) {
          if (desc.toLowerCase().includes(feature.toLowerCase())) {
            dead.push(feature);
            break;
          }
        }
      }
    }
  }

  return dead;
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
 * Scan test directory and find dead tests
 */
export function scanTestDirectory(testDir: string, baseDir: string): TestInfo[] {
  const testFiles = findTestFiles(testDir);
  const results: TestInfo[] = [];

  for (const filePath of testFiles) {
    const content = readFileSync(filePath, "utf-8");
    const relPath = relative(baseDir, filePath);
    const testInfo = parseTestFile(content, relPath);

    // Find dead imports
    const deadImports = findDeadImports(testInfo, baseDir);
    const deadReferences = findDeadTestReferences(testInfo);

    if (deadImports.length > 0 || deadReferences.length > 0) {
      testInfo.deadImports = deadImports;
      testInfo.deadReferences = deadReferences;
      results.push(testInfo);
    }
  }

  return results;
}

/**
 * Generate markdown report from dead test findings
 */
export function generateDeadTestsReport(findings: TestInfo[]): string {
  const lines: string[] = [];

  lines.push("# Dead Tests Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No dead tests detected. All test files are healthy!");
    return lines.join("\n");
  }

  lines.push(`Found **${findings.length}** test file(s) with issues:`);
  lines.push("");

  for (const finding of findings) {
    lines.push(`## ${finding.path}`);
    lines.push("");

    if (finding.deadImports && finding.deadImports.length > 0) {
      lines.push("### Missing Imports");
      lines.push("");
      for (const imp of finding.deadImports) {
        lines.push(`- \`${imp}\` — module not found`);
      }
      lines.push("");
    }

    if (finding.deadReferences && finding.deadReferences.length > 0) {
      lines.push("### Dead Feature References");
      lines.push("");
      for (const ref of finding.deadReferences) {
        lines.push(`- **${ref}** — references removed feature`);
      }
      lines.push("");
    }

    lines.push("**Recommendation:** Review this test file. ");
    lines.push(
      "Either fix the imports/references, update the test, or delete it if no longer needed."
    );
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total files with issues: ${findings.length}`);
  const totalDeadImports = findings.reduce(
    (sum, f) => sum + (f.deadImports?.length || 0),
    0
  );
  const totalDeadRefs = findings.reduce(
    (sum, f) => sum + (f.deadReferences?.length || 0),
    0
  );
  lines.push(`- Dead imports: ${totalDeadImports}`);
  lines.push(`- Dead references: ${totalDeadRefs}`);

  return lines.join("\n");
}

/**
 * Main function - orchestrates the dead test detection
 */
async function main() {
  const startTime = performance.now();
  const cwd = process.cwd();
  const testDir = join(cwd, "test");

  if (!existsSync(testDir)) {
    console.error("[FAIL] test/ directory not found");
    process.exit(1);
  }

  // Scan test directory
  const findings = scanTestDirectory(testDir, cwd);

  // Generate report
  const report = generateDeadTestsReport(findings);
  const reportPath = join(cwd, "docs", "dead-tests-report.md");

  // Ensure docs directory exists
  const docsDir = dirname(reportPath);
  if (!existsSync(docsDir)) {
    mkdirSync(docsDir, { recursive: true });
  }

  writeFileSync(reportPath, report);

  const endTime = performance.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  console.log(`[OK] Dead tests report written to ${reportPath}`);
  console.log(`Completed in ${duration}s`);

  // Summary
  console.log("");
  console.log("Summary:");
  console.log(`- Files with issues: ${findings.length}`);
  const totalDeadImports = findings.reduce(
    (sum, f) => sum + (f.deadImports?.length || 0),
    0
  );
  const totalDeadRefs = findings.reduce(
    (sum, f) => sum + (f.deadReferences?.length || 0),
    0
  );
  console.log(`- Dead imports: ${totalDeadImports}`);
  console.log(`- Dead references: ${totalDeadRefs}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
  });
}
