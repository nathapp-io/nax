/**
 * Greenfield Detection
 *
 * Detects whether a story is "greenfield" (no existing test files in workdir).
 * Greenfield stories skip TDD and use test-after strategy to prevent test-writer
 * from producing empty test files (BUG-010).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { UserStory } from "../prd/types";
import { globsToTestRegex } from "../test-runners/conventions";

/**
 * Broad fallback patterns for the greenfield scan — covers any test file
 * across all common languages without restricting to a single directory.
 * Patterns are expanded (no brace alternatives) so globsToTestRegex can build
 * correct suffix regexes. Used when the caller doesn't supply resolved patterns.
 */
const GREENFIELD_FALLBACK_PATTERNS: readonly string[] = Object.freeze([
  "**/*.test.ts",
  "**/*.test.js",
  "**/*.test.tsx",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.js",
  "**/*.spec.tsx",
  "**/*.spec.jsx",
  "**/*_test.go",
  "test_*.py",
  "*_test.py",
]);

/**
 * Recursively scan directory for test files.
 * Ignores node_modules, dist, build, .next directories.
 * Throws error if root directory is unreadable.
 */
async function scanForTestFiles(dir: string, testPatterns: RegExp[], isRootCall = true): Promise<string[]> {
  const results: string[] = [];
  const ignoreDirs = new Set(["node_modules", "dist", "build", ".next", ".git"]);

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip ignored directories
        if (ignoreDirs.has(entry.name)) continue;

        // Recursively scan subdirectories (not root call)
        const subResults = await scanForTestFiles(fullPath, testPatterns, false);
        results.push(...subResults);
      } else if (entry.isFile()) {
        // Check if file matches any test pattern
        if (testPatterns.some((re) => re.test(entry.name))) {
          results.push(fullPath);
        }
      }
    }
  } catch (error) {
    // If this is the root call and we can't read it, propagate the error
    if (isRootCall) {
      throw error;
    }
    // Otherwise, ignore errors from unreadable subdirectories
  }

  return results;
}

/**
 * Detect if a story is greenfield based on test file presence in workdir.
 *
 * A story is greenfield if:
 * - No test files exist matching any of the given patterns in the working directory
 *
 * This prevents the TDD test-writer from struggling to create tests when there are
 * no existing test examples to follow.
 *
 * @param story - User story to check
 * @param workdir - Working directory to scan for test files
 * @param patterns - Glob patterns for test files (default: DEFAULT_TEST_FILE_PATTERNS)
 * @returns true if no test files exist (greenfield), false otherwise
 *
 * @example
 * ```ts
 * // Empty project with no tests
 * const isGreenfield = await isGreenfieldStory(story, "/path/to/project");
 * // => true
 *
 * // Project with existing test files
 * const isGreenfield = await isGreenfieldStory(story, "/path/to/project");
 * // => false
 * ```
 */
export async function isGreenfieldStory(
  _story: UserStory,
  workdir: string,
  patterns?: readonly string[],
): Promise<boolean> {
  try {
    const regexes = globsToTestRegex(patterns ?? GREENFIELD_FALLBACK_PATTERNS);
    const testFiles = await scanForTestFiles(workdir, regexes);
    return testFiles.length === 0;
  } catch (error) {
    // If scan fails completely (e.g., workdir doesn't exist), assume not greenfield (safe fallback)
    // This prevents skipping TDD when we can't determine the actual state
    return false;
  }
}
