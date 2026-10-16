/**
 * Does the filesystem holding a directory compare paths case-insensitively?
 *
 * The owned-path screen (#2347) matches nax's own names -- `.nax`,
 * `.nax/mono/<package>/config.json`, `.nax/features/<feature>/prd.json`,
 * `.queue.txt` -- as root-relative SEGMENTS, exact-case. On a case-insensitive
 * filesystem (the macOS default) `.NAX/CONFIG.JSON` reaches the very file
 * `.nax/config.json` names, so an exact-case match is one hole wide: a planted
 * or rewritten config changes the commands nax runs, and those run through a
 * shell WITHOUT passing the permission gate.
 *
 * The probe is per FILESYSTEM, not per path: stat the nearest path (the root, or
 * an ancestor of it) whose last segment carries a cased letter, then the same
 * path with that segment's case swapped. One dev+ino pair means the two
 * spellings are one inode, which is what case-insensitivity means. The answer is
 * probed once per canonical root and cached -- the property cannot change while
 * the run is alive, and every refusal consults it.
 *
 * Fails CLOSED (`true`) whenever the probe cannot answer: no cased segment to
 * swap, or the original spelling cannot be stat'ed. A wrong `false` is exactly
 * the hole this module exists to close, while a wrong `true` refuses a path that
 * is not nax's own on a case-sensitive volume -- harmless, and the same posture
 * the typed-write path takes by folding case with no probe at all.
 */

import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { realOrRaw } from "@nathapp/nax-agent/internal";

/** The one external call, behind a seam so tests can drive both answers on either platform. */
export const _caseFsDeps = {
  stat: (p: string): { dev: number; ino: number } => statSync(p),
};

/** Canonical root -> answer: one probe per filesystem the run touches. */
const cache = new Map<string, boolean>();

/** Test hook: forget every probed root. */
export function _resetCaseFsCache(): void {
  cache.clear();
}

/** `segment` with every letter's case flipped: `Work` -> `wORK`. */
function swapCase(segment: string): string {
  return segment.replace(/[a-zA-Z]/g, (char) =>
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
  );
}

/**
 * The nearest of `p` and its ancestors whose last segment carries a cased letter,
 * or `undefined` when the walk reaches the filesystem root without finding one.
 *
 * Swapping the case of a segment with no cased letter would produce the same
 * path, and comparing a path against itself always looks case-insensitive --
 * a false `true` from a probe that never asked the filesystem anything.
 */
function casedProbePath(p: string): string | undefined {
  let current = p;
  for (;;) {
    if (/[a-zA-Z]/.test(basename(current))) return current;
    const parent = dirname(current);
    // `dirname` is a fixed point at the filesystem root: nothing cased on the way up.
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Stat `target`, then its case-swapped spelling. The same dev AND ino means one
 * inode under two spellings. An errno of `ENOENT`/`ENOTDIR` means the swapped
 * spelling is a different, absent path -- definitive, so case-sensitive. Any
 * other failure says the probe could not answer, which fails closed.
 */
function probeTarget(target: string): boolean {
  let original: { dev: number; ino: number };
  try {
    original = _caseFsDeps.stat(target);
  } catch {
    return true;
  }
  try {
    const swapped = _caseFsDeps.stat(join(dirname(target), swapCase(basename(target))));
    return swapped.dev === original.dev && swapped.ino === original.ino;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/**
 * Is the filesystem holding `root` case-insensitive? Cached per canonical root
 * (`realOrRaw`, so a symlinked spelling and its target share one probe).
 */
export function isCaseInsensitiveFs(root: string): boolean {
  const canonical = realOrRaw(root);
  const cached = cache.get(canonical);
  if (cached !== undefined) return cached;
  const target = casedProbePath(canonical);
  const answer = target === undefined ? true : probeTarget(target);
  cache.set(canonical, answer);
  return answer;
}
