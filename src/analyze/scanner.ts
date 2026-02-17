/**
 * Codebase Scanner
 *
 * Scans the project directory to generate a summary for LLM classification.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CodebaseScan } from "./types";

/**
 * Scan codebase to generate summary for LLM classification.
 *
 * Generates:
 * - File tree (src/ directory, max depth 3)
 * - Package.json dependencies
 * - Test pattern detection
 *
 * @param workdir - Project root directory
 * @returns Codebase scan result
 *
 * @example
 * ```ts
 * const scan = await scanCodebase("/path/to/project");
 * console.log(scan.fileTree);
 * console.log(scan.dependencies);
 * ```
 */
export async function scanCodebase(workdir: string): Promise<CodebaseScan> {
  const srcPath = join(workdir, "src");
  const packageJsonPath = join(workdir, "package.json");

  // Generate file tree (src/ only, max depth 3)
  const fileTree = existsSync(srcPath) ? await generateFileTree(srcPath, 3) : "No src/ directory";

  // Extract dependencies from package.json
  let dependencies: Record<string, string> = {};
  let devDependencies: Record<string, string> = {};

  if (existsSync(packageJsonPath)) {
    try {
      const pkg = await Bun.file(packageJsonPath).json();
      dependencies = pkg.dependencies || {};
      devDependencies = pkg.devDependencies || {};
    } catch {
      // Invalid package.json, use empty deps
    }
  }

  // Detect test patterns
  const testPatterns = detectTestPatterns(workdir, dependencies, devDependencies);

  return {
    fileTree,
    dependencies,
    devDependencies,
    testPatterns,
  };
}

/**
 * Generate file tree for a directory with depth limit.
 *
 * @param dir - Directory path
 * @param maxDepth - Maximum depth to traverse
 * @param currentDepth - Current depth (internal)
 * @param prefix - Line prefix for formatting (internal)
 * @returns Formatted file tree string
 */
async function generateFileTree(
  dir: string,
  maxDepth: number,
  currentDepth = 0,
  prefix = "",
): Promise<string> {
  if (currentDepth >= maxDepth) {
    return "";
  }

  const entries: string[] = [];

  try {
    const dirEntries = Array.from(
      new Bun.Glob("*").scanSync({
        cwd: dir,
        onlyFiles: false,
      }),
    );

    // Sort: directories first, then files
    dirEntries.sort((a, b) => {
      const aIsDir = !a.includes(".");
      const bIsDir = !b.includes(".");
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < dirEntries.length; i++) {
      const entry = dirEntries[i];
      const fullPath = join(dir, entry);
      const isLast = i === dirEntries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      // Check if directory
      const stat = await Bun.file(fullPath).stat();
      const isDir = stat.isDirectory();

      entries.push(`${prefix}${connector}${entry}${isDir ? "/" : ""}`);

      // Recurse into directories
      if (isDir) {
        const subtree = await generateFileTree(fullPath, maxDepth, currentDepth + 1, prefix + childPrefix);
        if (subtree) {
          entries.push(subtree);
        }
      }
    }
  } catch {
    // Directory not accessible, skip
  }

  return entries.join("\n");
}

/**
 * Detect test patterns from directory structure and dependencies.
 *
 * Checks for:
 * - Test framework (vitest, jest, bun:test, mocha, etc.)
 * - Test directory structure (test/, __tests__/)
 * - Test file patterns (*.test.ts, *.spec.ts)
 *
 * @param workdir - Project root directory
 * @param dependencies - Production dependencies
 * @param devDependencies - Dev dependencies
 * @returns Array of detected patterns
 */
function detectTestPatterns(
  workdir: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
): string[] {
  const patterns: string[] = [];
  const allDeps = { ...dependencies, ...devDependencies };

  // Detect test framework
  if (allDeps.vitest) {
    patterns.push("Test framework: vitest");
  } else if (allDeps.jest || allDeps["@jest/globals"]) {
    patterns.push("Test framework: jest");
  } else if (allDeps.mocha) {
    patterns.push("Test framework: mocha");
  } else if (allDeps.ava) {
    patterns.push("Test framework: ava");
  } else {
    // Check for bun:test (no package.json entry)
    patterns.push("Test framework: likely bun:test (no framework dependency)");
  }

  // Detect test directory
  if (existsSync(join(workdir, "test"))) {
    patterns.push("Test directory: test/");
  }
  if (existsSync(join(workdir, "__tests__"))) {
    patterns.push("Test directory: __tests__/");
  }
  if (existsSync(join(workdir, "tests"))) {
    patterns.push("Test directory: tests/");
  }

  // Detect test file patterns
  const hasTestFiles = existsSync(join(workdir, "test")) || existsSync(join(workdir, "src"));
  if (hasTestFiles) {
    patterns.push("Test files: *.test.ts, *.spec.ts");
  }

  return patterns;
}
