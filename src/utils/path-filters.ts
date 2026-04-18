/**
 * Path filters for nax-internal bookkeeping files.
 *
 * When surfacing "changed files" lists to LLM prompts (e.g. Session History in
 * SessionScratchProvider), nax-internal files (.nax/, nax.lock) are pure noise
 * that wastes tokens and adds no signal for the agent. This module provides the
 * single source of truth for which paths should be excluded from those views.
 *
 * See: #542
 */

/**
 * Return true when the given repo-relative path is a nax-internal bookkeeping
 * file and should be excluded from LLM-facing "changed files" listings.
 *
 * Matches:
 *   - `.nax/...`                          — repo-root nax dir
 *   - `any/prefix/.nax/...`               — per-package nax dir
 *   - `nax.lock`                          — root lock
 *   - `any/prefix/nax.lock`               — per-package lock
 */
export function isNaxInternalPath(path: string): boolean {
  if (path.startsWith(".nax/") || path.startsWith("./.nax/")) return true;
  if (path === "nax.lock" || path === "./nax.lock") return true;
  if (path.includes("/.nax/")) return true;
  if (path.endsWith("/nax.lock")) return true;
  return false;
}

/**
 * Filter a list of changed files, removing nax-internal bookkeeping entries.
 * Preserves order and does not mutate the input array.
 */
export function filterNaxInternalPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !isNaxInternalPath(p));
}
