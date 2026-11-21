/**
 * Decoding and project scoping of `git diff --name-only` output for the smart-runner readers.
 *
 * Pure helpers: the Git read and the Git-root lookup stay in smart-runner.ts, which passes the
 * resolved Git root in so this module never imports it back.
 */
import { relative, sep } from "node:path";
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
  return gitStylePrefix(relative(gitRoot, repoRoot), sep);
}

/**
 * Normalize a `relative()` result to Git's forward slashes; "" when it is empty or leaves the Git root.
 * `separator` is the platform separator (a parameter so both forms are testable).
 */
export function gitStylePrefix(rel: string, separator: string): string {
  const prefix = separator === "/" ? rel : rel.split(separator).join("/");
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
