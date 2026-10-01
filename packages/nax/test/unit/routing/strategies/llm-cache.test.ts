/**
 * Run-scoped routing-decision cache helpers (BUG-19). The cache itself lives
 * on `NaxRuntime.routingCache`; these tests exercise the helper functions
 * against a bare `Map` — no runtime construction needed.
 */
import { describe, expect, test } from "bun:test";
import type { RoutingDecision } from "@/routing/decision";
import {
  clearCache,
  clearCacheForStory,
  evictOldest,
  getCacheSize,
  injectCacheEntry,
  MAX_CACHE_SIZE,
} from "@/routing/strategies/llm-cache";

function makeDecision(reasoning: string): RoutingDecision {
  return { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning };
}

describe("routing cache helpers", () => {
  test("MAX_CACHE_SIZE is 100", () => {
    expect(MAX_CACHE_SIZE).toBe(100);
  });

  test("injectCacheEntry adds an entry, getCacheSize reflects it", () => {
    const cache = new Map<string, RoutingDecision>();
    expect(getCacheSize(cache)).toBe(0);
    injectCacheEntry(cache, "US-001", makeDecision("first"));
    expect(getCacheSize(cache)).toBe(1);
    expect(cache.get("US-001")?.reasoning).toBe("first");
  });

  test("clearCacheForStory removes only the named entry", () => {
    const cache = new Map<string, RoutingDecision>();
    injectCacheEntry(cache, "US-001", makeDecision("a"));
    injectCacheEntry(cache, "US-002", makeDecision("b"));
    clearCacheForStory(cache, "US-001");
    expect(cache.has("US-001")).toBe(false);
    expect(cache.has("US-002")).toBe(true);
  });

  test("clearCache empties the whole map", () => {
    const cache = new Map<string, RoutingDecision>();
    injectCacheEntry(cache, "US-001", makeDecision("a"));
    injectCacheEntry(cache, "US-002", makeDecision("b"));
    clearCache(cache);
    expect(getCacheSize(cache)).toBe(0);
  });

  describe("evictOldest", () => {
    test("removes the first-inserted entry (FIFO by insertion order)", () => {
      const cache = new Map<string, RoutingDecision>();
      injectCacheEntry(cache, "US-001", makeDecision("oldest"));
      injectCacheEntry(cache, "US-002", makeDecision("middle"));
      injectCacheEntry(cache, "US-003", makeDecision("newest"));

      evictOldest(cache);

      expect(cache.has("US-001")).toBe(false);
      expect(cache.has("US-002")).toBe(true);
      expect(cache.has("US-003")).toBe(true);
      expect(getCacheSize(cache)).toBe(2);
    });

    test("is a no-op on an empty cache", () => {
      const cache = new Map<string, RoutingDecision>();
      expect(() => evictOldest(cache)).not.toThrow();
      expect(getCacheSize(cache)).toBe(0);
    });

    test("does not promote a re-read entry — a hit does not move it to the back", () => {
      const cache = new Map<string, RoutingDecision>();
      injectCacheEntry(cache, "US-001", makeDecision("oldest"));
      injectCacheEntry(cache, "US-002", makeDecision("newest"));

      // Reading US-001 does not touch insertion order.
      void cache.get("US-001");

      evictOldest(cache);

      expect(cache.has("US-001")).toBe(false);
      expect(cache.has("US-002")).toBe(true);
    });
  });
});
