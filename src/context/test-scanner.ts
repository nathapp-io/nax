/**
 * Test File Scanner (v0.7)
 *
 * Scans test directories and extracts describe/test block names
 * to generate a coverage summary for prompt injection.
 * Prevents test duplication across isolated story sessions.
 */

import { Glob } from "bun";
import path from "node:path";
import { getLogger } from "../logger";
import { estimateTokens } from "./builder";

// ============================================================================
// Types
// ============================================================================

/** Detail level for test summary */
export type TestSummaryDetail = "names-only" | "names-and-counts" | "describe-blocks";

/** Options for scanning test files */
export interface TestScanOptions {
  /** Working directory (base for testDir) */
  workdir: string;
  /** Test directory relative to workdir (default: auto-detect) */
  testDir?: string;
  /** Glob pattern for test files (default: "**\/*.test.{ts,js,tsx,jsx}") */
  testPattern?: string;
  /** Max tokens for the summary (default: 500) */
  maxTokens?: number;
  /** Summary detail level (default: "names-and-counts") */
  detail?: TestSummaryDetail;
  /** Context files to scope test coverage to (default: undefined = scan all) */
  contextFiles?: string[];
  /** Enable scoping to context files (default: true) */
  scopeToStory?: boolean;
}

/** A single describe block extracted from a test file */
export interface DescribeBlock {
  name: string;
  tests: string[];
}

/** Parsed test file info */
export interface TestFileInfo {
  /** Relative path from workdir */
  relativePath: string;
  /** Total test count (it/test calls) */
  testCount: number;
  /** Top-level describe blocks with their test names */
  describes: DescribeBlock[];
}

/** Scan result */
export interface TestScanResult {
  files: TestFileInfo[];
  totalTests: number;
  summary: string;
  tokens: number;
}

// ============================================================================
// Regex Extraction
// ============================================================================

/**
 * Extract describe and test block names from test file source.
 *
 * Uses regex to find:
 * - `describe("name", ...)` / `describe('name', ...)`
 * - `test("name", ...)` / `it("name", ...)`
 *
 * Only extracts top-level describes (not nested). All test/it calls
 * are associated with the most recent describe block.
 */
export function extractTestStructure(source: string): { describes: DescribeBlock[]; testCount: number } {
  const describes: DescribeBlock[] = [];
  let currentDescribe: DescribeBlock | null = null;
  let testCount = 0;

  // Match describe/test/it calls with string arguments (single or double quotes, backticks)
  // Match describe/test/it calls anywhere (not just line-start) to handle single-line files
  const linePattern = /(?:^|\s|;|\{)(describe|test|it)\s*\(\s*(['"`])(.*?)\2/gm;

  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(source)) !== null) {
    const keyword = match[1];
    const name = match[3];

    if (keyword === "describe") {
      currentDescribe = { name, tests: [] };
      describes.push(currentDescribe);
    } else {
      // test or it
      testCount++;
      if (currentDescribe) {
        currentDescribe.tests.push(name);
      } else {
        // Top-level test without describe
        if (describes.length === 0 || describes[describes.length - 1].name !== "(top-level)") {
          describes.push({ name: "(top-level)", tests: [] });
        }
        describes[describes.length - 1].tests.push(name);
      }
    }
  }

  return { describes, testCount };
}

// ============================================================================
// File Scanning
// ============================================================================

/** Common test directory names to auto-detect */
const COMMON_TEST_DIRS = ["test", "tests", "__tests__", "src/__tests__", "spec"];

/**
 * Derive test file patterns from source file paths.
 *
 * Maps source files to their likely test file counterparts:
 * - src/foo.ts → test/foo.test.ts, test/foo.spec.ts
 * - src/bar/baz.service.ts → test/bar/baz.service.test.ts, test/baz.service.test.ts
 *
 * @param contextFiles - Array of source file paths (relative to workdir)
 * @returns Array of test file path patterns (basename patterns for matching)
 */
export function deriveTestPatterns(contextFiles: string[]): string[] {
  const patterns = new Set<string>();

  for (const filePath of contextFiles) {
    const basename = path.basename(filePath);
    const basenameNoExt = basename.replace(/\.(ts|js|tsx|jsx)$/, '');

    // Pattern 1: exact basename match with .test/.spec extension
    // e.g., foo.ts → foo.test.ts, foo.spec.ts
    patterns.add(`${basenameNoExt}.test.ts`);
    patterns.add(`${basenameNoExt}.test.js`);
    patterns.add(`${basenameNoExt}.test.tsx`);
    patterns.add(`${basenameNoExt}.test.jsx`);
    patterns.add(`${basenameNoExt}.spec.ts`);
    patterns.add(`${basenameNoExt}.spec.js`);
    patterns.add(`${basenameNoExt}.spec.tsx`);
    patterns.add(`${basenameNoExt}.spec.jsx`);

    // Pattern 2: if basename contains .service/.controller/etc, also match without it
    // e.g., foo.service.ts → foo.test.ts
    const simpleBasename = basenameNoExt.replace(/\.(service|controller|resolver|module|guard|middleware|util|helper)$/, '');
    if (simpleBasename !== basenameNoExt) {
      patterns.add(`${simpleBasename}.test.ts`);
      patterns.add(`${simpleBasename}.test.js`);
      patterns.add(`${simpleBasename}.spec.ts`);
      patterns.add(`${simpleBasename}.spec.js`);
    }
  }

  return Array.from(patterns);
}

/**
 * Auto-detect test directory by checking common locations.
 */
async function detectTestDir(workdir: string): Promise<string | null> {
  for (const dir of COMMON_TEST_DIRS) {
    const fullPath = path.join(workdir, dir);
    const file = Bun.file(path.join(fullPath, ".")); // Check directory exists
    try {
      const dirStat = await Bun.file(fullPath).exists();
      // Bun.file().exists() returns false for directories, use different check
      const proc = Bun.spawn(["test", "-d", fullPath], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode === 0) return dir;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Scan test files and extract structure.
 *
 * @param options - Scan options
 * @returns Array of parsed test file info
 */
export async function scanTestFiles(options: TestScanOptions): Promise<TestFileInfo[]> {
  const { workdir, testPattern = "**/*.test.{ts,js,tsx,jsx}", contextFiles, scopeToStory = true } = options;
  let testDir = options.testDir;

  // Auto-detect test directory if not specified
  if (!testDir) {
    testDir = await detectTestDir(workdir) || "test";
  }

  const scanDir = path.join(workdir, testDir);

  // Check directory exists
  const dirCheck = Bun.spawn(["test", "-d", scanDir], { stdout: "pipe", stderr: "pipe" });
  if (await dirCheck.exited !== 0) {
    return [];
  }

  // Derive test patterns from context files if scoping is enabled
  let allowedBasenames: Set<string> | null = null;
  if (scopeToStory && contextFiles && contextFiles.length > 0) {
    const patterns = deriveTestPatterns(contextFiles);
    allowedBasenames = new Set(patterns);
  }

  const glob = new Glob(testPattern);
  const files: TestFileInfo[] = [];

  for await (const filePath of glob.scan({ cwd: scanDir, absolute: false })) {
    // Filter by derived patterns if scoping is enabled
    if (allowedBasenames !== null) {
      const basename = path.basename(filePath);
      if (!allowedBasenames.has(basename)) {
        continue; // Skip test files not matching context files
      }
    }

    const fullPath = path.join(scanDir, filePath);
    try {
      const source = await Bun.file(fullPath).text();
      const { describes, testCount } = extractTestStructure(source);

      if (testCount > 0 || describes.length > 0) {
        files.push({
          relativePath: path.join(testDir, filePath),
          testCount,
          describes,
        });
      }
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  // Sort by path for stable output
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return files;
}

// ============================================================================
// Summary Formatting
// ============================================================================

/**
 * Format test files as a markdown summary at the specified detail level.
 */
export function formatTestSummary(files: TestFileInfo[], detail: TestSummaryDetail): string {
  if (files.length === 0) {
    return "";
  }

  const lines: string[] = [];
  const totalTests = files.reduce((sum, f) => sum + f.testCount, 0);

  lines.push(`## Existing Test Coverage (${totalTests} tests across ${files.length} files)`);
  lines.push("");
  lines.push("The following tests already exist. DO NOT duplicate this coverage.");
  lines.push("Focus only on testing NEW behavior introduced by this story.");
  lines.push("");

  for (const file of files) {
    switch (detail) {
      case "names-only":
        lines.push(`- **${file.relativePath}** (${file.testCount} tests)`);
        break;

      case "names-and-counts":
        lines.push(`### ${file.relativePath} (${file.testCount} tests)`);
        for (const desc of file.describes) {
          lines.push(`- ${desc.name} (${desc.tests.length} tests)`);
        }
        lines.push("");
        break;

      case "describe-blocks":
        lines.push(`### ${file.relativePath} (${file.testCount} tests)`);
        for (const desc of file.describes) {
          lines.push(`- **${desc.name}** (${desc.tests.length} tests)`);
          for (const test of desc.tests) {
            lines.push(`  - ${test}`);
          }
        }
        lines.push("");
        break;
    }
  }

  return lines.join("\n");
}

/**
 * Truncate summary to fit within token budget.
 *
 * Strategy: progressively reduce detail level, then truncate files.
 */
export function truncateToTokenBudget(
  files: TestFileInfo[],
  maxTokens: number,
  preferredDetail: TestSummaryDetail,
): { summary: string; detail: TestSummaryDetail; truncated: boolean } {
  // Try preferred detail level first
  const detailLevels: TestSummaryDetail[] = ["describe-blocks", "names-and-counts", "names-only"];
  const startIndex = detailLevels.indexOf(preferredDetail);

  for (let i = startIndex; i < detailLevels.length; i++) {
    const detail = detailLevels[i];
    const summary = formatTestSummary(files, detail);
    const tokens = estimateTokens(summary);

    if (tokens <= maxTokens) {
      return { summary, detail, truncated: i !== startIndex };
    }
  }

  // Even names-only exceeds budget — truncate files
  let truncatedFiles = [...files];
  while (truncatedFiles.length > 1) {
    truncatedFiles = truncatedFiles.slice(0, truncatedFiles.length - 1);
    const summary = formatTestSummary(truncatedFiles, "names-only") +
      `\n... and ${files.length - truncatedFiles.length} more test files`;
    if (estimateTokens(summary) <= maxTokens) {
      return { summary, detail: "names-only", truncated: true };
    }
  }

  // Last resort: just file count
  const fallback = `## Existing Test Coverage\n\n${files.length} test files with ${files.reduce((s, f) => s + f.testCount, 0)} total tests exist. Review test/ directory before adding new tests.`;
  return { summary: fallback, detail: "names-only", truncated: true };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Scan test files and generate a token-budgeted summary.
 *
 * @param options - Scan and formatting options
 * @returns Scan result with summary, or empty result if no tests found
 */
export async function generateTestCoverageSummary(options: TestScanOptions): Promise<TestScanResult> {
  const {
    maxTokens = 500,
    detail = "names-and-counts",
    contextFiles,
    scopeToStory = true,
  } = options;

  // Log warning if scoping is enabled but no context files provided
  if (scopeToStory && (!contextFiles || contextFiles.length === 0)) {
    try {
      const logger = getLogger();
      logger.warn("context", "scopeToStory=true but no contextFiles provided — falling back to full scan");
    } catch {
      // Logger not initialized (e.g., in tests) — silently skip
    }
  }

  const files = await scanTestFiles(options);

  if (files.length === 0) {
    return { files: [], totalTests: 0, summary: "", tokens: 0 };
  }

  const totalTests = files.reduce((sum, f) => sum + f.testCount, 0);
  const { summary } = truncateToTokenBudget(files, maxTokens, detail);
  const tokens = estimateTokens(summary);

  return { files, totalTests, summary, tokens };
}
