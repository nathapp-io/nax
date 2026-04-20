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

import { join, relative } from "node:path";

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

const NAX_IGNORE_FILENAME = ".naxignore";

export interface NaxIgnoreMatcher {
  readonly source: "root" | "package";
  readonly pattern: string;
  readonly test: (repoRelativePath: string) => boolean;
}

export const _pathFilterDeps = {
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
};

function basename(path: string): string {
  const stripped = path.startsWith("./") ? path.slice(2) : path;
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const beforeSlash = i > 0 && pattern[i - 1] === "/";
        const afterSlash = pattern[i + 2] === "/";
        if (beforeSlash && afterSlash) {
          regex = `${regex.slice(0, -1)}(?:.*\\/)?`;
          i += 3;
        } else if (afterSlash) {
          regex += "(?:.*\\/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
        continue;
      }
      regex += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      regex += "[^/]";
      i++;
      continue;
    }
    if (".+^${}()|[]\\".includes(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
    i++;
  }
  return new RegExp(`(?:^|/)${regex}$`);
}

function parseIgnoreFile(raw: string): string[] {
  const patterns: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = normalizePath(trimmed.endsWith("/") ? `${trimmed}**` : trimmed);
    if (normalized) patterns.push(normalized);
  }
  return patterns;
}

function compileMatcher(source: "root" | "package", pattern: string, packagePrefix: string | null): NaxIgnoreMatcher {
  const regex = globToRegex(pattern);
  return {
    source,
    pattern,
    test: (repoRelativePath: string): boolean => {
      const normalized = normalizePath(repoRelativePath);
      if (regex.test(normalized)) return true;
      if (source === "root" && packagePrefix) {
        return regex.test(`${packagePrefix}/${normalized}`);
      }
      return false;
    },
  };
}

async function readIgnorePatterns(filePath: string): Promise<string[]> {
  if (!(await _pathFilterDeps.fileExists(filePath))) return [];
  const raw = await _pathFilterDeps.readFile(filePath);
  return parseIgnoreFile(raw);
}

/**
 * Resolve `.naxignore` patterns for session-history changed-file filtering.
 *
 * Resolution order:
 *   1. root `<repoRoot>/.naxignore`
 *   2. package `<packageDir>/.naxignore` (when packageDir differs from repoRoot)
 */
export async function resolveNaxIgnorePatterns(repoRoot: string, packageDir?: string): Promise<NaxIgnoreMatcher[]> {
  const normalizedRepoRoot = normalizePath(repoRoot);
  const normalizedPackageDir = packageDir ? normalizePath(packageDir) : normalizedRepoRoot;
  const packagePrefix =
    normalizedPackageDir !== normalizedRepoRoot ? normalizePath(relative(repoRoot, packageDir ?? repoRoot)) : null;

  const rootFile = join(repoRoot, NAX_IGNORE_FILENAME);
  const packageFile = join(packageDir ?? repoRoot, NAX_IGNORE_FILENAME);

  const rootPatterns = await readIgnorePatterns(rootFile);
  const packagePatterns =
    packageDir && packageDir !== repoRoot ? await readIgnorePatterns(packageFile) : ([] as string[]);

  return [
    ...rootPatterns.map((p) => compileMatcher("root", p, packagePrefix)),
    ...packagePatterns.map((p) => compileMatcher("package", p, packagePrefix)),
  ];
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
export function filterNaxInternalPaths(
  paths: readonly string[],
  ignoreMatchers: readonly NaxIgnoreMatcher[] = [],
): string[] {
  return paths.filter((path) => !isNaxInternalPath(path) && !ignoreMatchers.some((matcher) => matcher.test(path)));
}
