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
import { clearCache, clearCacheForStory, getCacheSize, injectCacheEntry } from "../../../src/routing/strategies/llm";
import type { RoutingDecision } from "../../../src/routing/decision";

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

  test("two independent caches (simulating two runtimes) never see each other's entries", () => {
    const runA = new Map<string, RoutingDecision>();
    const runB = new Map<string, RoutingDecision>();

    // Same story id colliding across two "runs" — the BUG-19 scenario.
    injectCacheEntry(runA, "US-001", { ...DECISION, reasoning: "run A" });

    expect(runB.has("US-001")).toBe(false);
    expect(getCacheSize(runB)).toBe(0);
  });
});
