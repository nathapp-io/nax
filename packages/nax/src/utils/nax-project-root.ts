import { dirname, join, resolve } from "node:path";

const MAX_NAX_WALK_DEPTH = 10;

export const _naxProjectRootDeps = {
  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  },
};

/**
 * Walk up from startDir to find the nearest ancestor that contains `.nax/config.json`.
 * Returns that ancestor (the nax project root). Falls back to startDir if not found.
 *
 * Used by audit writers to consolidate files at the project root even when individual
 * stories run with a package subdir as their workdir (e.g. apps/api/).
 */
export async function findNaxProjectRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir);
  for (let depth = 0; depth < MAX_NAX_WALK_DEPTH; depth++) {
    if (await _naxProjectRootDeps.exists(join(dir, ".nax", "config.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}
