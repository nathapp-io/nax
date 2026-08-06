/**
 * Symlink-tolerant path normalisation for comparing paths from different sources.
 *
 * `getGitRoot` returns git's realpath — `git rev-parse --show-toplevel` run from
 * `/tmp/repo` answers `/private/tmp/repo` — while paths threaded through config,
 * pipeline context, or a story record keep whatever spelling the caller supplied.
 * On macOS `/tmp` is a symlink to `/private/tmp` and worktrees are created under
 * temp directories, so the two spellings meet constantly. Comparing them
 * unresolved makes equal paths look different, and every containment check
 * (`startsWith(root)`) silently fails closed.
 *
 * Pure apart from the `realpathSync` probe, and never throws.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Absolute, symlink-resolved form of `p`.
 *
 * A path that does not exist cannot be resolved directly, so this walks up to
 * the nearest ancestor that DOES exist, resolves that, and re-attaches the
 * remaining segments. Resolving only the immediate parent is not enough: a
 * changed file that has since been deleted, or one under a directory that was
 * never created, leaves several missing segments — and a half-resolved answer
 * compares unequal to a fully-resolved root, turning every containment check
 * into a silent false negative.
 *
 * Falls back to the lexical absolute form when no ancestor resolves.
 */
export function realOrRaw(p: string): string {
  const abs = resolve(p);
  const trailing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return trailing.length === 0 ? realpathSync(current) : join(realpathSync(current), ...trailing);
    } catch {
      const parent = dirname(current);
      // `dirname` is a fixed point at the filesystem root — nothing resolved.
      if (parent === current) return abs;
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Is `filePath` inside `root`'s subtree, symlinks resolved on both sides? */
export function isInside(root: string, filePath: string): boolean {
  const base = realOrRaw(root);
  const target = realOrRaw(filePath);
  return target === base || target.startsWith(`${base}${sep}`);
}
