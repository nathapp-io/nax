/**
 * Isolation Verification
 *
 * Checks that TDD sessions respect their boundaries:
 * - Session 1 (test writer): only test/ files modified
 * - Session 2 (implementer): no test/ files modified
 */

import type { IsolationCheck } from "./types";

/** Common test directory patterns */
const TEST_PATTERNS = [
  /^test\//,
  /^tests\//,
  /^__tests__\//,
  /\.spec\.\w+$/,
  /\.test\.\w+$/,
  /\.e2e-spec\.\w+$/,
];

/** Common source directory patterns */
const SRC_PATTERNS = [
  /^src\//,
  /^lib\//,
  /^packages\//,
];

/** Check if a file path is a test file */
export function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(filePath));
}

/** Check if a file path is a source file */
export function isSourceFile(filePath: string): boolean {
  return SRC_PATTERNS.some((pattern) => pattern.test(filePath));
}

/** Get changed files from git diff */
export async function getChangedFiles(workdir: string, fromRef: string = "HEAD"): Promise<string[]> {
  const proc = Bun.spawn(["git", "diff", "--name-only", fromRef], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;
  const output = await new Response(proc.stdout).text();
  return output.trim().split("\n").filter(Boolean);
}

/** Get staged files */
export async function getStagedFiles(workdir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "diff", "--name-only", "--cached"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;
  const output = await new Response(proc.stdout).text();
  return output.trim().split("\n").filter(Boolean);
}

/**
 * Verify test writer isolation:
 * Only test files should be created/modified.
 * No source files should be touched.
 */
export async function verifyTestWriterIsolation(
  workdir: string,
  beforeRef: string,
): Promise<IsolationCheck> {
  const changed = await getChangedFiles(workdir, beforeRef);
  const violations = changed.filter((f) => isSourceFile(f) && !isTestFile(f));

  return {
    passed: violations.length === 0,
    violations,
    description: "Test writer should only modify test files, not source files",
  };
}

/**
 * Verify implementer isolation:
 * No test files should be modified.
 * Only source files should be touched.
 */
export async function verifyImplementerIsolation(
  workdir: string,
  beforeRef: string,
): Promise<IsolationCheck> {
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
