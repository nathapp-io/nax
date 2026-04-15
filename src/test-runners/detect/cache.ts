/**
 * Detection Cache — read/write/invalidate
 *
 * Caches detection results by workdir + manifest mtimes to avoid
 * re-running detection on every pipeline invocation.
 *
 * Location: .nax/cache/test-patterns.json (gitignored)
 * Invalidation: any manifest mtime change triggers a cache miss.
 * Concurrency: last-write-wins; no file lock (derived data, cheap to rebuild).
 */

import { getSafeLogger } from "../../logger";
import type { DetectionResult } from "./types";

/** Manifest file names consulted during mtime-based invalidation */
export const CACHE_MANIFEST_FILES = [
  "package.json",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.cjs",
  "pyproject.toml",
  "pytest.ini",
  "setup.cfg",
  "go.mod",
  "Cargo.toml",
  ".mocharc.js",
  ".mocharc.cjs",
  ".mocharc.yaml",
  ".mocharc.yml",
  ".mocharc.json",
  "playwright.config.ts",
  "playwright.config.js",
  "cypress.config.ts",
  "cypress.config.js",
] as const;

interface CacheEntry {
  workdir: string;
  mtimes: Record<string, number>;
  result: DetectionResult;
}

/** Injectable deps for testability */
export const _cacheDeps = {
  fileMtime: async (path: string): Promise<number | null> => {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return (await f.stat()).mtime.getTime();
  },
  readJson: async (path: string): Promise<unknown> => JSON.parse(await Bun.file(path).text()),
  writeJson: async (path: string, data: unknown): Promise<void> => {
    await Bun.write(path, JSON.stringify(data, null, 2));
  },
};

/** Absolute path to the cache file for a given workdir */
export function cachePath(workdir: string): string {
  return `${workdir}/.nax/cache/test-patterns.json`;
}

/** Read and validate current manifest mtimes */
async function readCurrentMtimes(workdir: string): Promise<Record<string, number>> {
  const mtimes: Record<string, number> = {};
  await Promise.all(
    CACHE_MANIFEST_FILES.map(async (name) => {
      const mtime = await _cacheDeps.fileMtime(`${workdir}/${name}`);
      if (mtime !== null) mtimes[name] = mtime;
    }),
  );
  return mtimes;
}

/** Returns true if all cached mtimes match current values */
function isCacheValid(cached: Record<string, number>, current: Record<string, number>): boolean {
  const allKeys = new Set([...Object.keys(cached), ...Object.keys(current)]);
  for (const key of allKeys) {
    if (cached[key] !== current[key]) return false;
  }
  return true;
}

/**
 * Read cached detection result for a workdir.
 * Returns null on cache miss, stale mtimes, or corrupt JSON.
 */
export async function readCache(workdir: string): Promise<DetectionResult | null> {
  const path = cachePath(workdir);
  try {
    const raw = await _cacheDeps.readJson(path);
    const entry = raw as CacheEntry;
    if (!entry || typeof entry !== "object" || entry.workdir !== workdir) return null;

    const current = await readCurrentMtimes(workdir);
    if (!isCacheValid(entry.mtimes ?? {}, current)) return null;

    return entry.result ?? null;
  } catch {
    getSafeLogger()?.debug("detect", "Cache miss (corrupt or missing)", { workdir });
    return null;
  }
}

/**
 * Write detection result to cache.
 * Silently ignores write failures (cache is non-critical).
 */
export async function writeCache(workdir: string, result: DetectionResult): Promise<void> {
  const path = cachePath(workdir);
  try {
    const mtimes = await readCurrentMtimes(workdir);
    const entry: CacheEntry = { workdir, mtimes, result };
    await _cacheDeps.writeJson(path, entry);
  } catch {
    getSafeLogger()?.debug("detect", "Cache write failed (non-critical)", { workdir });
  }
}
