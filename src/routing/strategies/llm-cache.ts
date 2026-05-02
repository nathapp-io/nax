/**
 * LLM Routing Cache
 *
 * Module-level cache for routing decisions.
 * Extracted from llm.ts so router.ts can import it without pulling in the full
 * LLM strategy dependencies (IAgentManager, Bun.spawn, etc.).
 */

import type { RoutingDecision } from "../router";

/** Module-level cache for routing decisions (PERF-1 fix: max 100 entries LRU) */
export const cachedDecisions = new Map<string, RoutingDecision>();
export const MAX_CACHE_SIZE = 100;

/** Clear the routing cache (for testing or new runs) */
export function clearCache(): void {
  cachedDecisions.clear();
}

/** Get the current cache size (for testing) */
export function getCacheSize(): number {
  return cachedDecisions.size;
}

/** Clear routing cache entry for a specific story (used on tier escalation) */
export function clearCacheForStory(storyId: string): void {
  cachedDecisions.delete(storyId);
}

/** Inject a cache entry directly (test helper only) */
export function injectCacheEntry(storyId: string, decision: RoutingDecision): void {
  cachedDecisions.set(storyId, decision);
}

/** Evict oldest entry when cache is full (LRU) */
export function evictOldest(): void {
  const firstKey = cachedDecisions.keys().next().value;
  if (firstKey !== undefined) {
    cachedDecisions.delete(firstKey);
  }
}
