/**
 * LLM Routing Cache
 *
 * Helpers for the run-scoped routing-decision cache (BUG-19). The cache
 * itself lives on `NaxRuntime.routingCache` — a fresh `Map` per `createRuntime()`
 * call — rather than as a module-level singleton. A module-level `Map` persisted
 * across every `createRuntime()` call in the same process, so a decision cached
 * for `story.id` "US-001" in one run/feature could be served back to an
 * unrelated run/feature whose story ids happened to collide (e.g. two features
 * both starting from "US-001"), gated only by a per-story-id "first story of
 * the run" clear heuristic that itself missed parallel-routing and
 * skipped/paused-first-story cases. Scoping the `Map` to the runtime removes
 * both problems: each run starts with an empty cache, so no clear-on-first-story
 * heuristic is needed at all.
 *
 * Extracted from llm.ts so router.ts can import it without pulling in the full
 * LLM strategy dependencies (IAgentManager, Bun.spawn, etc.).
 */

import type { RoutingDecision } from "../decision";

/** Max entries per run-scoped cache before LRU eviction kicks in (PERF-1). */
export const MAX_CACHE_SIZE = 100;

/** Clear every entry in a routing cache. */
export function clearCache(cache: Map<string, RoutingDecision>): void {
  cache.clear();
}

/** Get the current size of a routing cache (for testing). */
export function getCacheSize(cache: Map<string, RoutingDecision>): number {
  return cache.size;
}

/** Clear a routing cache entry for a specific story (used on tier escalation). */
export function clearCacheForStory(cache: Map<string, RoutingDecision>, storyId: string): void {
  cache.delete(storyId);
}

/** Inject a cache entry directly (test helper only). */
export function injectCacheEntry(
  cache: Map<string, RoutingDecision>,
  storyId: string,
  decision: RoutingDecision,
): void {
  cache.set(storyId, decision);
}

/** Evict the oldest entry when a routing cache is full (LRU). */
export function evictOldest(cache: Map<string, RoutingDecision>): void {
  const firstKey = cache.keys().next().value;
  if (firstKey !== undefined) {
    cache.delete(firstKey);
  }
}
