/**
 * Pure path matching for the per-folder trust store (US-001).
 *
 * Two jobs: decide the root a gate should check (`resolveTrustRoot`) and
 * decide whether a normalized path is covered by a stored entry
 * (`findCoveringEntry`). Both work on realpath-normalized absolute paths, so
 * a path spelled through a symlinked parent (macOS `/var` -> `/private/var`)
 * or through a directory that does not exist yet still compares equal to the
 * entry it should match.
 */

import { dirname, resolve, sep } from "node:path";
import { findProjectDir, globalConfigDir } from "@/config";
import { realOrRaw } from "@/utils/realpath";
import type { TrustEntry } from "./types";

/**
 * The folder a gate should treat as the project root for `workdir`.
 *
 * When `findProjectDir` finds a `.nax/config.json` walking up from `workdir`,
 * that directory's parent is the root. The exception is the global config
 * directory itself: `~/.nax/config.json` IS a `.nax/config.json`, so without
 * the exclusion every project-less folder under the home directory would
 * resolve to the home directory -- and trusting the home directory trusts
 * everything under it.
 */
export function resolveTrustRoot(workdir: string): string {
  const naxDir = findProjectDir(workdir);
  if (naxDir !== null && realOrRaw(naxDir) !== realOrRaw(globalConfigDir())) {
    return dirname(naxDir);
  }
  return resolve(workdir);
}

/**
 * Absolute, symlink-resolved form of `path`, comparable with a stored entry.
 *
 * `realOrRaw` resolves the nearest EXISTING ancestor and re-appends the rest,
 * so a directory that has not been created yet is still normalized through its
 * real parent. The trailing separator is removed so `/a/b/` and `/a/b` are one
 * path -- except on the filesystem root, which is `/` and stays `/`.
 *
 * Async to match the interface the gate compiles against; the probe itself is
 * synchronous (`realOrRaw`, `src/utils/realpath.ts`).
 */
export async function normalizeTrustPath(path: string): Promise<string> {
  return normalizeTrustPathSync(path);
}

/**
 * The synchronous core of `normalizeTrustPath`.
 *
 * Shared with the process registry (`markTrusted`), which writes synchronously:
 * one normalization definition, so what the registry stores and what
 * `assertTrusted` queries can never drift apart.
 */
export function normalizeTrustPathSync(path: string): string {
  const resolved = realOrRaw(path);
  if (resolved.length > 1 && resolved.endsWith("/")) return resolved.slice(0, -1);
  return resolved;
}

/**
 * The stored entry that covers `normalizedPath`, or `null`.
 *
 * An entry covers a path when it equals it, is a root (`/`, or `C:\` on
 * Windows: an entry that already ends with the platform separator), or is a
 * prefix of it followed by that separator -- a bare `startsWith` would let
 * `/a/foo` cover `/a/foobar` (AC3). When several entries cover, the longest
 * wins so the most specific root is the one reported (`/a/b` over `/a` for
 * `/a/b/c`).
 */
export function findCoveringEntry(folders: readonly TrustEntry[], normalizedPath: string): TrustEntry | null {
  let best: TrustEntry | null = null;
  for (const folder of folders) {
    if (!covers(folder.path, normalizedPath)) continue;
    if (best === null || folder.path.length > best.path.length) best = folder;
  }
  return best;
}

/**
 * Is `normalizedPath` a folder that must never be granted implicitly: the
 * filesystem root or the operator's home directory?
 *
 * Trusting either covers every project a user owns, so both the entry gate and
 * `nax trust add` refuse them unless `--force` is passed. One definition, so
 * the gate and the CLI cannot drift apart.
 *
 * `homeDir` is a parameter rather than an import so each surface keeps its own
 * injected home seam (`_trustGateDeps.homedir` / `_cliTrustDeps.homedir`).
 */
export function isProtectedFolder(normalizedPath: string, homeDir: string): boolean {
  // `dirname(path) === path` is the platform-neutral "is this a root" test.
  if (dirname(normalizedPath) === normalizedPath) return true;
  return normalizedPath === realOrRaw(homeDir);
}

/**
 * Does the (normalized) entry path `entryPath` cover `normalizedPath`?
 *
 * Exported because the process registry (`registry.ts`) applies the same rule
 * to the roots it holds: one definition of "covered", whatever list of paths
 * the caller is testing.
 */
export function covers(entryPath: string, normalizedPath: string): boolean {
  if (normalizedPath === entryPath) return true;
  // An entry that ends with the separator is a root -- `/`, or `C:\` on
  // Windows -- and already carries the boundary, so everything beneath it is
  // covered. Every other entry needs the separator between it and a descendant,
  // or `/a/foo` would cover `/a/foobar` (AC3).
  if (entryPath.endsWith(sep)) return normalizedPath.startsWith(entryPath);
  return normalizedPath.startsWith(`${entryPath}${sep}`);
}
