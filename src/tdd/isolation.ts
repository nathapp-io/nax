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

const GIT_TIMEOUT_MS = 10_000;

/**
 * Injectable deps for testability — mock _isolationDeps.spawn instead of
 * global Bun.spawn. `timeoutMs` is injectable (mirrors
 * `_gitDeps.timeoutRetryGitTimeoutMs` in `src/utils/git.ts`) so the hang-path
 * test can assert the SIGKILL contract with a short deadline instead of
 * burning the full 10s production timeout in wall-clock.
 */
export const _isolationDeps = { spawn, timeoutMs: GIT_TIMEOUT_MS };

/**
 * BUG-31: bound the git spawn for TDD isolation with a hard deadline so a
 * wedged git (NFS / lock contention) cannot stall the stage indefinitely.
 * Mirrors src/utils/git.ts gitWithTimeout — duplicated locally so the TDD
 * stage's existing `_isolationDeps.spawn` mockability is preserved
 * (gitWithTimeout wraps `_gitDeps.spawn`, a different mock seam).
 */
async function runGitBounded(
  args: string[],
  workdir: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = _isolationDeps.spawn(["git", ...args], { cwd: workdir, stdout: "pipe", stderr: "pipe" });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already dead
    }
  }, _isolationDeps.timeoutMs);

  // Drain stdout/stderr concurrently with awaiting exit — a process that fills
  // either pipe's OS buffer (>64KB) before being read would otherwise block on
  // the write and never reach `exited`, defeating the timeout's own SIGKILL.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    throw new NaxError(`git ${args[0]} timed out after ${_isolationDeps.timeoutMs}ms`, "GIT_TIMEOUT", {
      stage: "tdd-isolation",
      args,
      timeoutMs: _isolationDeps.timeoutMs,
    });
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { stdout, stderr, exitCode };
}

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
  // BUG-31: time-bound the git calls (NFS / lock contention could otherwise
  // stall the TDD isolation stage indefinitely). Route through
  // _isolationDeps.spawn so existing tests that mock _isolationDeps.spawn
  // still get to fake git output without needing to also mock
  // _gitDeps.spawn (gitWithTimeout's own dependency).
  const [
    { stdout: output, stderr, exitCode },
    { stdout: statusOutput, stderr: statusStderr, exitCode: statusExitCode },
  ] = await Promise.all([
    runGitBounded(["diff", "--name-only", fromRef], workdir),
    runGitBounded(["status", "--porcelain"], workdir),
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
  const { stdout: output } = await runGitBounded(["diff", "--numstat", fromRef], workdir);

  const result = new Map<string, number>();
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const [addedStr, _deletedStr, path] = line.split("\t");
    const added = Number.parseInt(addedStr ?? "", 10);
    if (path && Number.isFinite(added)) result.set(path, added);
  }
  return result;
}

/** Regex metacharacters that must be matched literally inside an allow pattern. */
const REGEX_METACHARACTERS = ".+?^${}()|[]\\/";

/**
 * Translate a glob-style allow pattern into a fully-anchored RegExp.
 *
 * `**` matches across directory separators, `*` matches within one segment,
 * and every other character is matched literally.
 *
 * Built as a single left-to-right scan rather than chained `.replace()` calls,
 * which had four separate failure modes:
 *   - `*` -> `[^/]*` ran after `**` -> `.*` and rewrote the `*` **inside** the
 *     `.*` it had just produced, so the shipped default `src/**\/index.ts`
 *     compiled to `src/.[^/]*\/index.ts` and matched exactly one directory
 *     level — `src/a/b/index.ts` was reported as a hard violation.
 *   - `.` stayed a wildcard, so `src/a.ts` also allowed `src/axts.ts`, widening
 *     the allowlist and downgrading a real violation to soft.
 *   - `[id]`, `a+b`, `app(1)` — ordinary directory names — silently matched
 *     nothing, so allowed files were reported as violations.
 *   - an unbalanced `(` threw out of the whole isolation check.
 *
 * Anchored `^...$` against the repo-relative path. This is deliberately
 * stricter than the suffix-matching `globToRegex` in the context engine and
 * `utils/path-filters`: those decide which rules apply, whereas widening this
 * allowlist silently permits a source write the TDD session should not make.
 */
function allowPatternToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += REGEX_METACHARACTERS.includes(char) ? `\\${char}` : char;
  }
  // Every metacharacter is escaped above, so this can no longer throw.
  return new RegExp(`^${source}$`); // nosemgrep: detect-non-literal-regexp — pattern is escaped, not interpolated raw
}

/** Check if a file path matches any of the allowed patterns (glob-like) */
function matchesAllowedPath(filePath: string, allowedPaths: string[]): boolean {
  return allowedPaths.some((pattern) => allowPatternToRegex(pattern).test(filePath));
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
