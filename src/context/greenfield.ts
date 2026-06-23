/**
 * Greenfield Detection
 *
 * Detects whether a story is "greenfield" (no existing test files in workdir).
 * Greenfield stories drop three-session TDD for the single-session tdd-simple
 * strategy: the isolated test-writer is skipped on greenfield (it would produce
 * empty test files, BUG-010), so one session writes tests-first then implements.
 */

import type { UserStory } from "../prd/types";
import { DEFAULT_TEST_FILE_PATTERNS, isTestFileByPatterns } from "../test-runners";

/** Injectable deps for testability. */
export const _greenfieldDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
};

/** Directories excluded from the Bun.Glob fallback scan (non-git workdirs only). */
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".eggs",
  "target",
  ".gradle",
  "out",
  "tmp",
  "temp",
  ".git",
]);

/**
 * List files in workdir via `git ls-files`.
 * Returns null when git is unavailable or the directory is not a repo.
 */
async function gitLsFiles(workdir: string): Promise<string[] | null> {
  try {
    const proc = _greenfieldDeps.spawn(["git", "ls-files"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain stdout concurrently with exited to avoid pipe-buffer deadlock on
    // large repos (git blocks writing when the ~64KB OS buffer fills).
    const [exitCode, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (exitCode !== 0) return null;
    return output.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Return true if at least one test file exists in `workdir` matching `patterns`.
 * Uses `git ls-files` as primary; falls back to Bun.Glob for non-git workdirs.
 */
async function hasTestFiles(workdir: string, patterns: readonly string[]): Promise<boolean> {
  const files = await gitLsFiles(workdir);

  if (files !== null) {
    return files.some((f) => isTestFileByPatterns(f, patterns));
  }

  // Fallback: Bun.Glob scan for non-git workdirs (e.g. temp fixtures in tests).
  for (const pattern of patterns) {
    const g = new Bun.Glob(pattern);
    for await (const path of g.scan({ cwd: workdir, onlyFiles: true })) {
      if (!path.split("/").some((seg) => IGNORE_DIRS.has(seg))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect if a story is greenfield based on test file presence in workdir.
 *
 * A story is greenfield if no test files matching the given patterns exist
 * in the working directory.
 *
 * Production callers (the routing pre-check and `greenfieldGateOp`) always pass
 * patterns resolved through `resolveTestFilePatterns()` — the ADR-009 SSOT,
 * whose detection tier finds pre-existing tests across languages. The `patterns`
 * argument is therefore the single source of truth. When omitted (ad-hoc / test
 * callers only), it falls back to `DEFAULT_TEST_FILE_PATTERNS` — the SAME default
 * `verifyTestWriterIsolation` uses, so greenfield detection and test-writer
 * isolation classify test files identically.
 *
 * @returns true if no test files exist (greenfield), false otherwise
 */
export async function isGreenfieldStory(
  _story: UserStory,
  workdir: string,
  patterns?: readonly string[],
): Promise<boolean> {
  try {
    return !(await hasTestFiles(workdir, patterns ?? DEFAULT_TEST_FILE_PATTERNS));
  } catch {
    // Scan failed (e.g. workdir doesn't exist) — assume not greenfield so TDD is not skipped.
    return false;
  }
}
