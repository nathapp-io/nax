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

/**
 * Recursively scan directory for test files.
 * Ignores node_modules, dist, build, .next directories.
 * Throws error if root directory is unreadable.
 */
async function scanForTestFiles(dir: string, testPattern: RegExp, isRootCall = true): Promise<string[]> {
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
        const subResults = await scanForTestFiles(fullPath, testPattern, false);
        results.push(...subResults);
      } else if (entry.isFile()) {
        // Check if file matches test pattern
        if (testPattern.test(entry.name)) {
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
 * Convert simple glob pattern to regex.
 * Supports:
 * - ** (any directory depth)
 * - * (any characters except /)
 * - {a,b,c} (alternatives)
 */
function globToRegex(pattern: string): RegExp {
  // Extract filename pattern from glob (everything after last /)
  const parts = pattern.split("/");
  const filePattern = parts[parts.length - 1];

  // Convert glob syntax to regex
  const regexStr = filePattern
    .replace(/\./g, "\\.") // Escape dots
    .replace(/\*/g, "[^/]*") // * = any chars except /
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.replace(/,/g, "|")})`) // {a,b} = (a|b)
    .replace(/\\\.\\\*/g, "\\.[^/]*"); // Fix escaped .* back to .\*

  return new RegExp(`${regexStr}$`); // nosemgrep: detect-non-literal-regexp — pattern from internal .gitignore, not user input
}

/**
 * Detect if a story is greenfield based on test file presence in workdir.
 *
 * A story is greenfield if:
 * - No test files exist matching the test pattern in the working directory
 *
 * This prevents the TDD test-writer from struggling to create tests when there are
 * no existing test examples to follow.
 *
 * @param story - User story to check
 * @param workdir - Working directory to scan for test files
 * @param testPattern - Glob pattern for test files (default: "**\/*.{test,spec}.{ts,js,tsx,jsx}")
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
  testPattern = "**/*.{test,spec}.{ts,js,tsx,jsx}",
): Promise<boolean> {
  try {
    const regex = globToRegex(testPattern);
    const testFiles = await scanForTestFiles(workdir, regex);
    return testFiles.length === 0;
  } catch (error) {
    // If scan fails completely (e.g., workdir doesn't exist), assume not greenfield (safe fallback)
    // This prevents skipping TDD when we can't determine the actual state
    return false;
  }
}
