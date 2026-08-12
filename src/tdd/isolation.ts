/**
 * Isolation Verification
 *
 * Checks that TDD sessions respect their boundaries:
 * - Session 1 (test writer): only test/ files modified
 * - Session 2 (implementer): no test/ files modified
 *
 * Both `verifyTestWriterIsolation` and `verifyImplementerIsolation` accept an
 * optional `testFilePatterns` argument. When supplied, classification uses those
 * patterns (config-aware path — ADR-009). When omitted, falls back to
 * DEFAULT_TEST_FILE_PATTERNS for backward compatibility.
 */

import { NaxError } from "../errors";
import { DEFAULT_TEST_FILE_PATTERNS, isTestFileByPatterns } from "../test-runners";
import { spawn } from "../utils/bun-deps";
import type { IsolationCheck } from "./types";

/** Injectable deps for testability — mock _isolationDeps.spawn instead of global Bun.spawn */
export const _isolationDeps = { spawn };

/** Common source directory patterns */
const SRC_PATTERNS = [/^src\//, /^lib\//, /^packages\//];

/** Check if a file path is a source file */
export function isSourceFile(filePath: string): boolean {
  return SRC_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Get changed files from git diff, merged with untracked files from git status.
 *
 * `git diff --name-only` alone is blind to untracked files (e.g. a brand-new
 * stub or test file a TDD session created), which would let an isolation
 * violation pass silently. Untracked entries (`?? path`) from `git status
 * --porcelain` are merged in and deduped.
 */
export async function getChangedFiles(workdir: string, fromRef = "HEAD"): Promise<string[]> {
  const diffProc = _isolationDeps.spawn(["git", "diff", "--name-only", fromRef], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const statusProc = _isolationDeps.spawn(["git", "status", "--porcelain"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Use Bun.readableStreamToText — more reliable than new Response(stream).text()
  // with both real pipes and mocked ReadableStreams across Bun versions.
  // Must read BEFORE awaiting proc.exited to avoid stream-closed-on-exit issues.
  // Drain stdout+stderr concurrently with proc.exited — sequential reads would
  // deadlock on a pipe-buffer-sized stderr (~64KB), and stderr must be read
  // regardless of exit code so a failure isn't silently discarded.
  const [output, stderr, exitCode, statusOutput, statusStderr, statusExitCode] = await Promise.all([
    Bun.readableStreamToText(diffProc.stdout),
    Bun.readableStreamToText(diffProc.stderr),
    diffProc.exited,
    Bun.readableStreamToText(statusProc.stdout),
    Bun.readableStreamToText(statusProc.stderr),
    statusProc.exited,
  ]);

  if (exitCode !== 0) {
    throw new NaxError(
      `git diff --name-only ${fromRef} failed (exit ${exitCode}): ${stderr.trim()}`,
      "GIT_DIFF_FAILED",
      {
        stage: "tdd-isolation",
        fromRef,
        exitCode,
      },
    );
  }

  if (statusExitCode !== 0) {
    throw new NaxError(
      `git status --porcelain failed (exit ${statusExitCode}): ${statusStderr.trim()}`,
      "GIT_DIFF_FAILED",
      {
        stage: "tdd-isolation",
        fromRef,
        exitCode: statusExitCode,
      },
    );
  }

  const diffFiles = output.trim().split("\n").filter(Boolean);
  const untrackedFiles = statusOutput
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);

  return [...new Set([...diffFiles, ...untrackedFiles])];
}

/**
 * Count added (non-blank) lines per file via `git diff --numstat`.
 * Used by the lite-mode stub heuristic — files with small additions are stub-sized.
 */
export async function getAddedLinesPerFile(workdir: string, fromRef = "HEAD"): Promise<Map<string, number>> {
  const proc = _isolationDeps.spawn(["git", "diff", "--numstat", fromRef], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await Bun.readableStreamToText(proc.stdout);
  await proc.exited;

  const result = new Map<string, number>();
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const [addedStr, _deletedStr, path] = line.split("\t");
    const added = Number.parseInt(addedStr ?? "", 10);
    if (path && Number.isFinite(added)) result.set(path, added);
  }
  return result;
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
 * Default ceiling for stub-sized src/ additions in lite mode.
 * The lite prompt asks for "≤3 lines each" stubs; we allow headroom for imports,
 * class scaffolding, and small dataclasses without crossing into real logic.
 */
export const LITE_STUB_ADDED_LINES_CEILING = 20;

/**
 * Verify test writer isolation:
 * Only test files should be created/modified.
 * No source files should be touched.
 *
 * @param workdir          - Working directory
 * @param beforeRef        - Git ref to diff against
 * @param allowedPaths     - Glob patterns for files that can be modified (soft violations)
 * @param testFilePatterns - Configured test file globs (ADR-009). Falls back to DEFAULT_TEST_FILE_PATTERNS.
 * @param mode             - "strict" (no src/ writes) or "lite" (stub-sized src/ writes allowed as soft violations).
 *                           Lite mode mirrors the test-writer prompt contract (isolation.ts:67) which permits
 *                           minimal stubs in src/ so imports compile. Files with added-line count ≤
 *                           LITE_STUB_ADDED_LINES_CEILING are treated as stubs (soft); larger files stay hard.
 */
export async function verifyTestWriterIsolation(
  workdir: string,
  beforeRef: string,
  allowedPaths: string[] = ["src/index.ts", "src/**/index.ts"],
  testFilePatterns: readonly string[] = DEFAULT_TEST_FILE_PATTERNS,
  mode: "strict" | "lite" = "strict",
): Promise<IsolationCheck> {
  const changed = await getChangedFiles(workdir, beforeRef);
  const sourceFiles = changed.filter((f) => isSourceFile(f) && !isTestFileByPatterns(f, testFilePatterns));

  // Lite mode resolves stub-sized src/ writes (≤ ceiling added lines) into soft violations.
  // Strict mode skips numstat entirely.
  const addedLines = mode === "lite" && sourceFiles.length > 0 ? await getAddedLinesPerFile(workdir, beforeRef) : null;

  // Separate hard violations from soft violations (allowed paths + lite stub allowance)
  const softViolations: string[] = [];
  const violations: string[] = [];

  for (const file of sourceFiles) {
    if (matchesAllowedPath(file, allowedPaths)) {
      softViolations.push(file);
      continue;
    }
    if (addedLines) {
      const added = addedLines.get(file) ?? Number.POSITIVE_INFINITY;
      if (added <= LITE_STUB_ADDED_LINES_CEILING) {
        softViolations.push(file);
        continue;
      }
    }
    violations.push(file);
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
 *
 * @param workdir          - Working directory
 * @param beforeRef        - Git ref to diff against
 * @param testFilePatterns - Configured test file globs (ADR-009). Falls back to DEFAULT_TEST_FILE_PATTERNS.
 */
export async function verifyImplementerIsolation(
  workdir: string,
  beforeRef: string,
  testFilePatterns: readonly string[] = DEFAULT_TEST_FILE_PATTERNS,
): Promise<IsolationCheck> {
  const changed = await getChangedFiles(workdir, beforeRef);
  const testFiles = changed.filter((f) => isTestFileByPatterns(f, testFilePatterns));

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
