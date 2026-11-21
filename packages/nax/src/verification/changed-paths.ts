/**
 * Decoding and project scoping of `git diff --name-only` output for the smart-runner readers.
 *
 * Pure helpers: the Git read and the Git-root lookup stay in smart-runner.ts, which passes the
 * resolved Git root in so this module never imports it back.
 */
import { relative } from "node:path";
import { unquotePorcelainPath } from "../utils/porcelain";

/** Split Git stdout into lines and decode each Git-quoted name; unquoted lines are returned as they are. */
export function decodeChangedLines(stdout: string): string[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => unquotePorcelainPath(line));
}

/**
 * The project's prefix under the Git root (`relative(gitRoot, repoRoot)`), or "" when there is no
 * Git root, the roots coincide, or the Git root is not an ancestor of `repoRoot`.
 */
export function projectPrefixUnderGitRoot(gitRoot: string | null, repoRoot: string): string {
  if (!gitRoot) return "";
  const prefix = relative(gitRoot, repoRoot);
  if (prefix === "" || prefix === ".." || prefix.startsWith("../")) return "";
  return prefix;
}

/** Keep only paths under `<prefix>/`; with no prefix, every path is kept. */
export function keepUnderPrefix(paths: string[], prefix: string): string[] {
  return prefix ? paths.filter((p) => p.startsWith(`${prefix}/`)) : paths;
}

/** Remove the leading `<prefix>/` from paths that carry it. */
export function stripPrefix(paths: string[], prefix: string): string[] {
  return prefix ? paths.map((p) => (p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : p)) : paths;
}
