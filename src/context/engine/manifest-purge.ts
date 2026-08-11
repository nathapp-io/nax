/**
 * Context Engine — Manifest Retention Purge (US-001)
 *
 * purgeStaleManifests() walks every feature's story directories under
 * the project's `.nax/features/` tree, deletes `context-manifest-*.json`
 * and `rebuild-manifest.json` files whose mtime is older than
 * `retentionDays`, then attempts a *non-recursive* rmdir on each story
 * directory it touched. The non-recursive removal is the safety property:
 * it fails harmlessly when any non-manifest artifact remains.
 *
 * Retention is age-based on file mtime, not keep-newest-N. Discovery uses
 * one capped glob scanned relative to projectDir, per
 * `monorepo-awareness.md` section 6.
 */

import { dirname, resolve } from "node:path";
import { getLogger } from "@/logger";

/** Maximum number of manifest entries the sweep will examine per invocation. */
export const MAX_MANIFEST_SCAN = 5000;

const DAY_MS = 86_400_000;
const MANIFEST_PATTERN = ".nax/features/*/stories/*/{context-manifest-*,rebuild-manifest}.json";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestPurgeDeps {
  /** Current time in ms (epoch). Tests inject a fixed value. */
  now: () => number;
  /**
   * Capped glob scan. Returns entries relative to `cwd` (matches the
   * `Bun.Glob(...).scanSync({ cwd, absolute: false })` contract). Returns
   * at most `cap` entries. `purgeStaleManifests` is responsible for logging
   * when the cap is reached.
   */
  scan: (pattern: string, cwd: string, cap: number) => Promise<string[]>;
  /**
   * Lookup of a file's mtime in ms. Throwing means "leave the file alone" —
   * the sweep must treat unreadable files as best-effort skips.
   */
  statMtime: (path: string) => Promise<number>;
  unlink: (path: string) => Promise<void>;
  /**
   * Non-recursive directory removal. Returns true when the directory was
   * removed; false when non-manifest artifacts remained (or the call
   * failed harmlessly). Must never perform recursive deletion against a
   * path built from feature/story names.
   */
  rmdirIfEmpty: (path: string) => Promise<boolean>;
  /** Emit a debug-level log line. */
  debugLog: (stage: string, message: string, data?: Record<string, unknown>) => void;
}

export const _manifestPurgeDeps: ManifestPurgeDeps = {
  now: () => Date.now(),
  scan: async (pattern: string, cwd: string, cap: number): Promise<string[]> => {
    const results: string[] = [];
    const g = new Bun.Glob(pattern);
    // `dot: true` lets the pattern walk into the `.nax/` directory; without it
    // Bun.Glob treats leading-dot segments as hidden and matches nothing.
    for (const entry of g.scanSync({ cwd, absolute: false, dot: true })) {
      if (results.length >= cap) break;
      results.push(entry);
    }
    return results;
  },
  statMtime: async (path: string): Promise<number> => {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`stat: file not found: ${path}`);
    const stat = await file.stat();
    return stat.mtimeMs;
  },
  unlink: async (path: string): Promise<void> => {
    const { unlink: nodeUnlink } = await import("node:fs/promises");
    await nodeUnlink(path);
  },
  rmdirIfEmpty: async (path: string): Promise<boolean> => {
    const { rmdir } = await import("node:fs/promises");
    try {
      await rmdir(path);
      return true;
    } catch {
      return false;
    }
  },
  debugLog: (stage, message, data) => {
    const logger = getLogger();
    logger?.debug(stage, message, data);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Purge context-manifest-*.json and rebuild-manifest.json files older than
 * `retentionDays`. Scans every feature directory (not just the running
 * feature) because the sweep runs at run completion and must bound total
 * manifest growth on the repository.
 *
 * @param projectDir    Absolute path to the project root (where .nax/ lives)
 * @param retentionDays Manifests with mtime older than this are deleted
 * @returns Number of manifest files that were deleted
 */
export async function purgeStaleManifests(projectDir: string, retentionDays: number): Promise<number> {
  const allEntries = await _manifestPurgeDeps.scan(MANIFEST_PATTERN, projectDir, MAX_MANIFEST_SCAN);
  if (allEntries.length >= MAX_MANIFEST_SCAN) {
    _manifestPurgeDeps.debugLog(
      "manifest-purge",
      `Manifest scan reached MAX_MANIFEST_SCAN=${MAX_MANIFEST_SCAN}; stopping further examination`,
      { cap: MAX_MANIFEST_SCAN, projectDir },
    );
  }
  const entries = allEntries.slice(0, MAX_MANIFEST_SCAN);
  const cutoffMs = _manifestPurgeDeps.now() - retentionDays * DAY_MS;

  let deleted = 0;
  /** Story directories touched this run — deduped so rmdir runs once per dir. */
  const touchedDirs = new Set<string>();

  for (const relPath of entries) {
    const absPath = resolve(projectDir, relPath);
    let mtimeMs: number;
    try {
      mtimeMs = await _manifestPurgeDeps.statMtime(absPath);
    } catch {
      // AC-9/AC-10: leave the file on disk, exclude from count.
      continue;
    }
    if (mtimeMs >= cutoffMs) continue;

    try {
      await _manifestPurgeDeps.unlink(absPath);
      deleted++;
      touchedDirs.add(dirname(absPath));
    } catch {
      // Best-effort — leave the file in place on failure.
    }
  }

  for (const storyDir of touchedDirs) {
    await _manifestPurgeDeps.rmdirIfEmpty(storyDir);
  }

  return deleted;
}
