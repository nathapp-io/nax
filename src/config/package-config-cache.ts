/**
 * Per-package resolved-config cache for `loadConfigForWorkdir`.
 *
 * `loadConfigForWorkdir` re-reads, re-shims, re-merges, env-resolves and
 * Zod-validates `.nax/mono/<pkg>/config.json` for every story each run, with no
 * result cache — only the root load is cached (`loader.ts` `_rootConfigCache`).
 * This module caches the final merged `NaxConfig` so the whole per-package
 * pipeline runs at most once per (root config, package, profile) in a run.
 *
 * The key MUST include the active profile chain. A `--profile` run resolves a
 * different root config, so keying without it would silently serve one profile's
 * merged config to another run — the nax#2126 defect class.
 *
 * Only ever populated for a monorepo package that actually ships an override at
 * `.nax/mono/<pkg>/config.json`; a missing package config returns the (already
 * cached) root config before the cache is consulted.
 *
 * @internal
 */

import type { NaxConfig } from "./schema";

const PACKAGE_CONFIG_CACHE_MAX = 50;
const cache = new Map<string, NaxConfig>();

/** Collision-free composite key for (root config path, package dir, profile chain). */
function cacheKeyFor(rootConfigPath: string, packageDir: string, profileKey: string): string {
  return JSON.stringify([rootConfigPath, packageDir, profileKey]);
}

export const packageConfigCache = {
  get(rootConfigPath: string, packageDir: string, profileKey: string): NaxConfig | undefined {
    return cache.get(cacheKeyFor(rootConfigPath, packageDir, profileKey));
  },
  /** Store a resolved config and return it, so callers can `return` the set. */
  set(rootConfigPath: string, packageDir: string, profileKey: string, value: NaxConfig): NaxConfig {
    const key = cacheKeyFor(rootConfigPath, packageDir, profileKey);
    if (!cache.has(key) && cache.size >= PACKAGE_CONFIG_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
    return value;
  },
  clear(): void {
    cache.clear();
  },
};

/** Clear the per-package config cache (for testing). @internal */
export function _clearPackageConfigCache(): void {
  packageConfigCache.clear();
}
