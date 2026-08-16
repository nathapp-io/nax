/**
 * CTX-2: loadCanonicalRules re-globs `.nax/rules/**\/*.md`, re-reads every
 * file, and re-runs the per-line neutrality lint — INSIDE fetch(), which
 * createDefaultOrchestrator calls fresh per stage assembly (~6-8 times per
 * story). Rules are immutable within a run, so this is pure repeat I/O.
 * Memoized per (workdir) for the process lifetime. `_resetCanonicalRulesCache`
 * exists for tests that mutate a rules dir mid-suite and need a fresh read.
 */

import { loadCanonicalRules } from "../../rules/canonical-loader";
import type { CanonicalRule } from "../../rules/canonical-loader";

const canonicalRulesCache = new Map<string, Promise<CanonicalRule[]>>();

export function memoizedLoadCanonicalRules(
  workdir: string,
  options?: Parameters<typeof loadCanonicalRules>[1],
): Promise<CanonicalRule[]> {
  const cached = canonicalRulesCache.get(workdir);
  if (cached) return cached;
  const loaded = loadCanonicalRules(workdir, options);
  canonicalRulesCache.set(workdir, loaded);
  // Don't cache a rejection — a transient read failure shouldn't poison every
  // subsequent assembly for the rest of the run.
  loaded.catch(() => canonicalRulesCache.delete(workdir));
  return loaded;
}

/** Test-only: clear the per-workdir canonical-rules memoization cache. */
export function _resetCanonicalRulesCache(): void {
  canonicalRulesCache.clear();
}
