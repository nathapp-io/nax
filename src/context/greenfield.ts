/**
 * Greenfield Detection
 *
 * Detects whether a story is "greenfield" (no existing test files in workdir).
 * Greenfield stories drop three-session TDD for the single-session tdd-simple
 * strategy: the isolated test-writer is skipped on greenfield (it would produce
 * empty test files, BUG-010), so one session writes tests-first then implements.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { UserStory } from "../prd/types";
import {
  buildResolved,
  createTestFileClassifier,
  DEFAULT_TEST_FILE_PATTERNS,
  isTestFileByPatterns,
  type ResolvedTestPatterns,
} from "../test-runners";

/** Injectable deps for testability. */
export const _greenfieldDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
};

/** Directories excluded from the on-disk walk (used by `walkFiles` for the non-git
 * fallback path; the git-ls-files branch relies on git's own exclude rules). */
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
  // nax's own artifact dir — its generated `.nax-acceptance.test.ts` harness is
  // NOT source-tree coverage and must never count as an authored test file.
  ".nax",
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
 * Walk `root` once and yield the relative path of every regular file, pruning
 * directories in `IGNORE_DIRS` at descent time so `node_modules`, `.venv`, etc.
 * never enter the queue. Symlinks are not followed.
 *
 * Throws if `root` itself is missing or unreadable (preserves the original
 * `Bun.Glob.scan` "throw on missing workdir" contract callers rely on for
 * fail-open). Permission errors on subdirectories are swallowed — those dirs
 * typically live inside `IGNORE_DIRS` (e.g. protected `.venv`).
 */
async function* walkFiles(root: string): AsyncIterable<string> {
  const queue: string[] = [root];
  let isRoot = true;
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      isRoot = false;
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          queue.push(full);
        } else if (entry.isFile()) {
          yield relative(root, full);
        }
      }
    } catch (err) {
      if (isRoot) {
        throw new Error(`[greenfield] cannot read workdir '${root}': ${(err as Error).message}`);
      }
      // Subdirectory we don't have permission to read — skip it; the parent
      // walk continues. Permission errors inside `IGNORE_DIRS` are expected.
    }
  }
}

/**
 * Return true if at least one test file matching `resolved.regex` exists ON DISK
 * in `workdir` — tracked OR untracked. Walks the tree once (pruning
 * `IGNORE_DIRS` to keep nax artifacts and dependency dirs out of the scan) and
 * classifies each path with the depth-agnostic `createTestFileClassifier`, so
 * the verdict agrees with the routing pre-check `isGreenfieldStory` makes from
 * `git ls-files` + `isTestFileByPatterns` (which also uses `.regex`). Fixes the
 * #1725 depth-semantics divergence where raw globs fed to `Bun.Glob.scan`
 * anchored at the cwd root and missed nested test files.
 *
 * Use this (not `isGreenfieldStory`) for any POST-implementer check: by then
 * the authored tests are untracked, and `git ls-files` would not list them.
 */
export async function hasTestFilesOnDisk(workdir: string, resolved: ResolvedTestPatterns): Promise<boolean> {
  const isTestFile = createTestFileClassifier(resolved);
  for await (const relPath of walkFiles(workdir)) {
    if (isTestFile(relPath)) return true;
  }
  return false;
}

/**
 * Return true if at least one test file exists in `workdir` matching `patterns`.
 * Uses `git ls-files` as primary; falls back to a filesystem scan for non-git
 * workdirs. PRE-implementer only — tracked-file semantics are intentional here so
 * the greenfield pre-check reflects committed state.
 */
async function hasTestFiles(workdir: string, patterns: readonly string[]): Promise<boolean> {
  const files = await gitLsFiles(workdir);

  if (files !== null) {
    // Git branch already uses the depth-agnostic `isTestFileByPatterns` (regex)
    // — the same depth semantics as `hasTestFilesOnDisk` after the #1725 fix,
    // so both paths agree by construction. Intentionally untouched.
    return files.some((f) => isTestFileByPatterns(f, patterns));
  }

  // Fallback: filesystem scan for non-git workdirs (e.g. temp fixtures in tests).
  // Build the resolved struct on the fly so the depth-agnostic classifier is
  // used in the fallback too (#1725).
  return hasTestFilesOnDisk(workdir, buildResolved(patterns, "fallback"));
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
