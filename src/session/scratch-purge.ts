/**
 * Session Scratch Retention — AC-20
 *
 * purgeStaleScratch() scans on-disk session directories for a feature and
 * deletes (or archives) those whose lastActivityAt is older than retentionDays.
 *
 * Called from run-completion.ts at the end of each run.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _scratchPurgeDeps = {
  /** List session IDs (directory names) under the sessions dir */
  listSessionDirs: async (sessionsDir: string): Promise<string[]> => {
    try {
      const ids: string[] = [];
      for await (const entry of new Bun.Glob("*").scan({ cwd: sessionsDir, absolute: false })) {
        ids.push(entry);
      }
      return ids;
    } catch {
      return [];
    }
  },
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  remove: (path: string): Promise<void> => rm(path, { recursive: true, force: true }),
  move: async (src: string, dest: string): Promise<void> => {
    await mkdir(dirname(dest), { recursive: true });
    await rename(src, dest);
  },
  now: () => Date.now(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Purge session scratch directories older than retentionDays.
 *
 * @param projectDir    Absolute path to the project root (where .nax/ lives)
 * @param featureName   Feature name — scans .nax/features/<featureName>/sessions/
 * @param retentionDays Sessions with lastActivityAt older than this are purged
 * @param archiveInsteadOfDelete  When true, move to _archive/ instead of deleting
 * @returns Number of session dirs that were purged or archived
 */
export async function purgeStaleScratch(
  projectDir: string,
  featureName: string,
  retentionDays: number,
  archiveInsteadOfDelete = false,
): Promise<number> {
  const sessionsDir = join(projectDir, ".nax", "features", featureName, "sessions");
  const sessionIds = await _scratchPurgeDeps.listSessionDirs(sessionsDir);

  const cutoffMs = _scratchPurgeDeps.now() - retentionDays * 86_400_000;
  let purged = 0;

  for (const sessionId of sessionIds) {
    const sessionDir = join(sessionsDir, sessionId);
    const descriptorPath = join(sessionDir, "descriptor.json");

    if (!(await _scratchPurgeDeps.fileExists(descriptorPath))) continue;

    let lastActivityAt: string | undefined;
    try {
      const raw = await _scratchPurgeDeps.readFile(descriptorPath);
      const descriptor = JSON.parse(raw) as Record<string, unknown>;
      lastActivityAt = descriptor.lastActivityAt as string | undefined;
    } catch {
      continue;
    }

    if (!lastActivityAt) continue;

    // Skip sessions still within the retention window (boundary is non-inclusive)
    if (new Date(lastActivityAt).getTime() >= cutoffMs) continue;

    if (archiveInsteadOfDelete) {
      const archiveDest = join(projectDir, ".nax", "features", featureName, "_archive", "sessions", sessionId);
      await _scratchPurgeDeps.move(sessionDir, archiveDest);
    } else {
      await _scratchPurgeDeps.remove(sessionDir);
    }
    purged++;
  }

  return purged;
}
