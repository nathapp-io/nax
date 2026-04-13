/**
 * Isolation Verification
 *
 * Checks that TDD sessions respect their boundaries:
 * - Session 1 (test writer): only test/ files modified
 * - Session 2 (implementer): no test/ files modified
 */

import { isTestFile } from "../test-runners";
import { spawn } from "../utils/bun-deps";
import type { IsolationCheck } from "./types";

/** Injectable deps for testability — mock _isolationDeps.spawn instead of global Bun.spawn */
export const _isolationDeps = { spawn };

// Re-export so existing callers (src/tdd/index.ts, tests) don't need to change imports.
export { isTestFile };

/** Common source directory patterns */
const SRC_PATTERNS = [/^src\//, /^lib\//, /^packages\//];

/** Check if a file path is a source file */
export function isSourceFile(filePath: string): boolean {
  return SRC_PATTERNS.some((pattern) => pattern.test(filePath));
}

/** Get changed files from git diff */
export async function getChangedFiles(workdir: string, fromRef = "HEAD"): Promise<string[]> {
  const proc = _isolationDeps.spawn(["git", "diff", "--name-only", fromRef], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Use Bun.readableStreamToText — more reliable than new Response(stream).text()
  // with both real pipes and mocked ReadableStreams across Bun versions.
  // Must read BEFORE awaiting proc.exited to avoid stream-closed-on-exit issues.
  const output = await Bun.readableStreamToText(proc.stdout);
  await proc.exited;

  return output.trim().split("\n").filter(Boolean);
}

/** Check if a file path matches any of the allowed patterns (glob-like) */
function matchesAllowedPath(filePath: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((pattern) => {
    // Simple glob matching: ** = any directory, * = any filename segment
    const regexPattern = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\//g, "\\/");
    const regex = new RegExp(`^${regexPattern}$`); // nosemgrep: detect-non-literal-regexp — pattern from PRD scope config, not user input
    return regex.test(filePath);
  });
}

/**
 * Verify test writer isolation:
 * Only test files should be created/modified.
 * No source files should be touched.
 *
 * @param workdir - Working directory
 * @param beforeRef - Git ref to diff against
 * @param allowedPaths - Glob patterns for files that can be modified (soft violations)
 */
export async function verifyTestWriterIsolation(
  workdir: string,
  beforeRef: string,
  allowedPaths: string[] = ["src/index.ts", "src/**/index.ts"],
): Promise<IsolationCheck> {
  const changed = await getChangedFiles(workdir, beforeRef);
  const sourceFiles = changed.filter((f) => isSourceFile(f) && !isTestFile(f));

  // Separate hard violations from soft violations (allowed paths)
  const softViolations: string[] = [];
  const violations: string[] = [];

  for (const file of sourceFiles) {
    if (matchesAllowedPath(file, allowedPaths)) {
      softViolations.push(file);
    } else {
      violations.push(file);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    softViolations,
    description: "Test writer should only modify test files, not source files",
  };
}

/**
 * Verify implementer isolation:
 * No test files should be modified.
 * Only source files should be touched.
 */
export async function verifyImplementerIsolation(workdir: string, beforeRef: string): Promise<IsolationCheck> {
  const changed = await getChangedFiles(workdir, beforeRef);
  const testFiles = changed.filter((f) => isTestFile(f));

  if (testFiles.length > 0) {
    return {
      passed: true, // Warn but pass
      violations: [],
      warnings: testFiles,
      description: "Implementer modified test files (warning: should be minimal fixes only)",
    };
  }

  return {
    passed: true,
    violations: [],
    description: "Implementer should not modify test files",
  };
}
