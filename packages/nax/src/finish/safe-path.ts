/**
 * Finish A §4: containment checks for the paths set-aside removes or writes.
 *
 * A path that git reports is root-relative, but a directory on the way to it may have
 * become a symlink since (the session can do that). Every removal and write checks that
 * the real parent directory is still inside the real repository root.
 */
import { realpath } from "node:fs/promises";
import { dirname, sep } from "node:path";

/**
 * True when the nearest existing ancestor of `target` resolves inside the real `root`.
 * Checked on the nearest existing ancestor so it can run before any `mkdir`.
 */
export async function insideRoot(root: string, target: string): Promise<boolean> {
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null) return false;
  let dir = dirname(target);
  for (;;) {
    const real = await realpath(dir).catch(() => null);
    if (real !== null) return real === realRoot || real.startsWith(realRoot + sep);
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}
