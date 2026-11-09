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
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

/** Most symlinks followed while resolving one path; a longer chain is treated as a cycle. */
const MAX_LINK_HOPS = 40;

/** The raw `readlink` text of `path`, or null when `path` is not a symlink (or does not exist). */
function linkText(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
  } catch {
    return null;
  }
}

const segmentsOf = (path: string): string[] => path.split(sep).filter((seg) => seg !== "" && seg !== ".");

/**
 * Component-by-component resolution for a path that `realpathSync` rejected.
 *
 * `base` is always fully resolved, so a `..` takes its parent exactly as the
 * kernel does: after any symlink earlier in the path has been followed. A
 * link target is therefore never collapsed as a string -- `evil/../x` with
 * `evil` pointing outside the root names a location outside the root, not
 * `<root>/x`. Returns null on a cycle.
 */
function walkSegments(abs: string): string | null {
  const root = parse(abs).root;
  const queue = segmentsOf(abs.slice(root.length));
  let base = root;
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift() as string;
    if (seg === "..") {
      base = dirname(base);
      continue;
    }
    const next = join(base, seg);
    const target = linkText(next);
    if (target === null) {
      // Canonicalise when it exists; keep the plain spelling for a missing segment.
      base = existingRealpath(next) ?? next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) return null;
    const targetRoot = isAbsolute(target) ? parse(target).root : "";
    if (targetRoot !== "") base = targetRoot;
    queue.unshift(...segmentsOf(target.slice(targetRoot.length)));
  }
  return base;
}

function existingRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Absolute, symlink-resolved form of `p`.
 *
 * A path that does not exist cannot be resolved directly by `realpathSync`, so
 * the remainder is walked segment by segment from the filesystem root. A
 * missing segment is kept as written, which is how a changed file that has
 * since been deleted, or one under a directory that was never created, still
 * compares equal to a fully-resolved root.
 *
 * A segment that is a symlink whose target is missing (a dangling link) is
 * replaced by its target and the walk continues from there: a write through it
 * creates the target, so a containment check must judge that location, not the
 * link's own. Following stops after `MAX_LINK_HOPS`; a cycle returns the
 * lexical form, which no write can follow either.
 *
 * Never throws; falls back to the lexical absolute form on any failure.
 */
export function realOrRaw(p: string): string {
  const abs = resolve(p);
  const direct = existingRealpath(abs);
  if (direct !== null) return direct;
  try {
    return walkSegments(abs) ?? abs;
  } catch {
    return abs;
  }
}

/** Is `filePath` inside `root`'s subtree, symlinks resolved on both sides? */
export function isInside(root: string, filePath: string): boolean {
  const base = realOrRaw(root);
  const target = realOrRaw(filePath);
  return target === base || target.startsWith(`${base}${sep}`);
}
