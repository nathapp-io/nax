/**
 * Finish A §4: containment checks for the paths set-aside removes or writes.
 *
 * A path that git reports is root-relative, but a directory on the way to it may have
 * become a symlink since (the session can do that). Every removal and write checks that
 * the real parent directory is still inside the real repository root.
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

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

/** `realpath` of the nearest existing ancestor of `target`, with the missing tail appended. */
async function realpathLoose(target: string): Promise<string> {
  const real = await realpath(target).catch(() => null);
  if (real !== null) return real;
  const up = dirname(target);
  return up === target ? target : join(await realpathLoose(up), basename(target));
}

/**
 * The root-relative path of `dir` (posix separators) when it lies strictly inside the real `root`, else
 * null. Lets a caller drop everything under a directory (e.g. the in-repo audit dir) from a git listing.
 */
export async function relativeInsideRoot(root: string, dir: string): Promise<string | null> {
  const [realRoot, realDir] = await Promise.all([realpathLoose(root), realpathLoose(dir)]);
  const rel = relative(realRoot, realDir);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return null;
  return rel.split(sep).join("/");
}

/** Paths that are not `excluded` itself or under it. `excluded` null keeps everything. */
export function outsideDir(paths: string[], excluded: string | null): string[] {
  if (excluded === null) return paths;
  return paths.filter((p) => p !== excluded && !p.startsWith(`${excluded}/`));
}
