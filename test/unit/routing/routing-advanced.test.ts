// RE-ARCH: keep
/**
 * Routing Tests
 *
 * Consolidated test suite for routing system including:
 * - LLM cache clearing (BUG-028)
 * - Run-scoped cache utilities (BUG-19) — each test builds its own Map instead
 *   of sharing a module-level singleton, mirroring how NaxRuntime.routingCache
 *   is a fresh instance per run.
 */

import { describe, expect, test } from "bun:test";
import type { RoutingDecision } from "@/routing/decision";
import { clearCache, clearCacheForStory, getCacheSize, injectCacheEntry } from "@/routing/strategies/llm";

const DECISION: RoutingDecision = {
  complexity: "simple",
  modelTier: "fast",
  testStrategy: "tdd-simple",
  reasoning: "test fixture",
};

describe("LLM Cache Clearing on Tier Escalation", () => {
  test("cache starts empty before any routing decisions", () => {
    const cache = new Map<string, RoutingDecision>();
    expect(getCacheSize(cache)).toBe(0);
  });

  test("clearCacheForStory removes cache entry", () => {
    const cache = new Map<string, RoutingDecision>();
    const storyId = "US-cache-002";
    injectCacheEntry(cache, storyId, DECISION);
    expect(getCacheSize(cache)).toBe(1);

    clearCacheForStory(cache, storyId);
    expect(getCacheSize(cache)).toBe(0);
  });

  test("clearCacheForStory after tier escalation forces re-routing", () => {
    const cache = new Map<string, RoutingDecision>();
    const storyId = "US-cache-003";
    injectCacheEntry(cache, storyId, DECISION);

    clearCacheForStory(cache, storyId);

    expect(cache.has(storyId)).toBe(false);
  });

  test("clearing one story does not affect other cached stories", () => {
    const cache = new Map<string, RoutingDecision>();
    const story1Id = "US-escalate-1";
    const story2Id = "US-escalate-2";
    injectCacheEntry(cache, story1Id, DECISION);
    injectCacheEntry(cache, story2Id, DECISION);

    clearCacheForStory(cache, story1Id);

    expect(cache.has(story1Id)).toBe(false);
    expect(cache.has(story2Id)).toBe(true);
    expect(getCacheSize(cache)).toBe(1);
  });

  test("clearCacheForStory is idempotent", () => {
    const cache = new Map<string, RoutingDecision>();
    const storyId = "US-idempotent";
    injectCacheEntry(cache, storyId, DECISION);

    clearCacheForStory(cache, storyId);
    clearCacheForStory(cache, storyId);
    clearCacheForStory(cache, storyId);

    expect(getCacheSize(cache)).toBe(0);
  });

  test("clearCache empties every entry regardless of story id", () => {
    const cache = new Map<string, RoutingDecision>();
    injectCacheEntry(cache, "US-1", DECISION);
    injectCacheEntry(cache, "US-2", DECISION);

    clearCache(cache);

    expect(getCacheSize(cache)).toBe(0);
  });

  // Instance-identity coverage — two real NaxRuntime instances never sharing a
  // cache, and resolveRouting() actually reading/writing per-runtime — lives in
  // test/unit/runtime/runtime.test.ts and test/unit/routing/llm-batch-route.test.ts.
  // A test built from two bare `new Map()`s here would prove nothing about
  // production wiring — two different Maps are trivially different regardless
  // of whether the fix exists.
});
