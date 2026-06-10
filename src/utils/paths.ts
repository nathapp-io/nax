/**
 * Shared path utilities
 */

import { join, relative, sep } from "node:path";
import { globalConfigDir } from "../config/paths";

/**
 * Compute the monorepo package directory **relative** to the repo root, as
 * `resolveTestFilePatterns()` expects it (third argument).
 *
 * Returns `undefined` for single-package repos (workdir === projectDir) and for
 * any case where `workdir` is not contained within `projectDir` (e.g. worktree
 * mode where `workdir` points outside the repo root) — callers then resolve
 * patterns against the repo root with no package scoping.
 *
 * SSOT: both the routing stage (greenfield pre-check) and plan-inputs (gate +
 * isolation inputs) call this so they resolve test-file patterns against an
 * identical package anchor. See `.claude/rules/monorepo-awareness.md` §C.
 */
export function packageDirRelative(projectDir: string, workdir: string): string | undefined {
  if (!projectDir || !workdir || workdir === projectDir) return undefined;
  const rel = relative(projectDir, workdir);
  if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
  return rel && rel !== "." ? rel : undefined;
}

/**
 * Get the central runs directory, respecting NAX_RUNS_DIR env var override.
 */
export function getRunsDir(): string {
  return process.env.NAX_RUNS_DIR ?? join(globalConfigDir(), "runs");
}

/**
 * Get the central events directory beneath the global nax dir.
 */
export function getEventsRootDir(): string {
  return join(globalConfigDir(), "events");
}
