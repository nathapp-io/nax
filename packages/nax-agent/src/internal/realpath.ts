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

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Most symlinks followed while resolving one path; a longer chain is treated as a cycle. */
const MAX_LINK_HOPS = 40;

/** Link target of `path` resolved against the link's own directory, or null when `path` is not a symlink. */
function danglingLinkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

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
 * A re-attached segment that is itself a symlink is a dangling link (its
 * target is missing, which is why `realpathSync` failed): a write through it
 * creates the target, so the segment is replaced by the link target and
 * resolution continues from there. Otherwise a containment check would judge
 * the link's own lexical location, not where the write lands. Following stops
 * after `MAX_LINK_HOPS`; a cycle returns the lexical form, which no write can
 * follow either.
 *
 * Falls back to the lexical absolute form when no ancestor resolves.
 */
export function realOrRaw(p: string): string {
  const abs = resolve(p);
  let hops = 0;
  let pending = abs;
  for (;;) {
    const trailing: string[] = [];
    let current = pending;
    let resolved: string | null = null;
    while (resolved === null) {
      try {
        resolved = realpathSync(current);
      } catch {
        const parent = dirname(current);
        // `dirname` is a fixed point at the filesystem root — nothing resolved.
        if (parent === current) return abs;
        trailing.unshift(basename(current));
        current = parent;
      }
    }
    // Walk the unresolved tail; the first dangling link restarts resolution at its target.
    let base = resolved;
    for (let i = 0; i < trailing.length; i++) {
      const next = join(base, trailing[i] as string);
      const target = danglingLinkTarget(next);
      if (target === null) {
        base = next;
        continue;
      }
      hops += 1;
      if (hops > MAX_LINK_HOPS) return abs;
      pending = join(target, ...trailing.slice(i + 1));
      base = "";
      break;
    }
    if (base !== "") return base;
  }
}

/** Is `filePath` inside `root`'s subtree, symlinks resolved on both sides? */
export function isInside(root: string, filePath: string): boolean {
  const base = realOrRaw(root);
  const target = realOrRaw(filePath);
  return target === base || target.startsWith(`${base}${sep}`);
}
