/**
 * Ensure Story Package Directories
 *
 * When a PRD story targets a package that does not exist yet (a new feature on
 * a brand-new package — e.g. `story.workdir = "packages/portfolio"`), nax
 * resolves the agent session's cwd to `join(repoRoot, story.workdir)` and hands
 * that path to acpx. `posix_spawn` cannot start a subprocess in a nonexistent
 * cwd, so every session dies on launch: the implementer hard-fails
 * ("Failed to spawn agent command"), and the acceptance generator degrades
 * silently to a skeleton test. No run could ever bootstrap a new package.
 *
 * This module creates any missing story package directories once, up front,
 * before either the pre-run acceptance pipeline or the execution loop opens a
 * session — fixing both symptoms at a single chokepoint.
 */

import path from "node:path";
import { getSafeLogger } from "../logger";
import type { PRD } from "../prd";

/**
 * Injectable filesystem dependencies. Tests override these to avoid touching
 * real disk; production uses Bun.file().exists() + node:fs/promises mkdir
 * (no Bun-native mkdir equivalent — same pattern as semantic-verdict.ts).
 */
export const _ensurePackageDirsDeps = {
  // Bun.file(dir).exists() returns false for directories — use stat().isDirectory().
  exists: async (p: string): Promise<boolean> => {
    const { stat } = await import("node:fs/promises");
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  mkdirp: async (p: string): Promise<void> => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(p, { recursive: true });
  },
};

/**
 * Create package directories for any story whose `workdir` points to a path
 * that does not yet exist under the repo root. Idempotent: existing dirs are
 * left untouched. Stories without a workdir (root-scoped) are ignored.
 *
 * Directory existence (not file existence) is what matters because acpx needs a
 * real directory as cwd. Note `Bun.file(dir).exists()` returns false for
 * directories, so the default dep uses stat().isDirectory().
 *
 * @param prd - The PRD whose stories may target new packages.
 * @param workdir - Absolute repo root.
 * @param deps - Injectable FS deps (test seam).
 * @returns Absolute paths of the directories that were created.
 */
export async function ensureStoryPackageDirs(
  prd: PRD,
  workdir: string,
  deps: typeof _ensurePackageDirsDeps = _ensurePackageDirsDeps,
): Promise<string[]> {
  const logger = getSafeLogger();

  // Map unique relative workdir -> a representative storyId for log correlation.
  const relToStoryId = new Map<string, string>();
  for (const story of prd.userStories) {
    const rel = story.workdir?.trim();
    if (!rel) continue;
    if (!relToStoryId.has(rel)) relToStoryId.set(rel, story.id);
  }

  const created: string[] = [];
  for (const [rel, storyId] of relToStoryId) {
    const abs = path.resolve(workdir, rel);

    // Safety: never create directories outside the repo root (defends against
    // a malformed PRD with `../` traversal in workdir).
    const rootWithSep = workdir.endsWith(path.sep) ? workdir : workdir + path.sep;
    if (abs !== workdir && !abs.startsWith(rootWithSep)) {
      logger?.warn("execution", "Skipping story workdir outside repo root", {
        storyId,
        packageDir: rel,
        resolved: abs,
      });
      continue;
    }

    if (await deps.exists(abs)) continue;

    await deps.mkdirp(abs);
    created.push(abs);
    logger?.info("execution", "Created missing package directory for story", {
      storyId,
      packageDir: rel,
      resolved: abs,
    });
  }

  return created;
}
