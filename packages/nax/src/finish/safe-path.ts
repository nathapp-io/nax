/** Realpath-based containment for directories excluded from shared git commits. */
import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

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
