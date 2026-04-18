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
 * Package-manager lockfiles — high-churn machine-generated files that add no
 * signal to an agent reviewing "what did the previous session change?".
 */
const LOCKFILE_BASENAMES = new Set<string>([
  "nax.lock",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
]);

function basename(path: string): string {
  const stripped = path.startsWith("./") ? path.slice(2) : path;
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}

/**
 * Return true when the given repo-relative path is a nax-internal bookkeeping
 * file or a package-manager lockfile and should be excluded from LLM-facing
 * "changed files" listings.
 *
 * Matches:
 *   - `.nax/...`                          — repo-root nax dir
 *   - `any/prefix/.nax/...`               — per-package nax dir
 *   - `nax.lock`, `any/prefix/nax.lock`   — nax run lock
 *   - Common lockfiles (bun.lock, package-lock.json, yarn.lock, pnpm-lock.yaml,
 *     go.sum, Cargo.lock, poetry.lock, uv.lock, Pipfile.lock, composer.lock,
 *     Gemfile.lock) at any depth
 */
export function isNaxInternalPath(path: string): boolean {
  if (path.startsWith(".nax/") || path.startsWith("./.nax/")) return true;
  if (path.includes("/.nax/")) return true;
  return LOCKFILE_BASENAMES.has(basename(path));
}

/**
 * Filter a list of changed files, removing nax-internal bookkeeping entries.
 * Preserves order and does not mutate the input array.
 */
export function filterNaxInternalPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => !isNaxInternalPath(p));
}
