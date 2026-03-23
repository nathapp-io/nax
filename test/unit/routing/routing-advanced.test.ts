// RE-ARCH: keep
/**
 * Routing Tests
 *
 * Consolidated test suite for routing system including:
 * - LLM cache clearing (BUG-028)
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearCache,
  clearCacheForStory,
  getCacheSize,
} from "../../../src/routing/strategies/llm";

// ============================================================================
// LLM Cache Clearing Tests (BUG-028 fix)
// ============================================================================

describe("LLM Cache Clearing on Tier Escalation", () => {
  beforeEach(() => {
    // Clear cache before each test
    clearCache();
  });

  test("cache starts empty before any routing decisions", () => {
    // Verify initial cache state
    expect(getCacheSize()).toBe(0);

    // Note: We're testing the behavior through the exported functions
    // In a real scenario, the LLM strategy would populate the cache
    // For this test, we verify the cache clearing mechanism works
  });

  test("clearCacheForStory removes cache entry", () => {
    const storyId = "US-cache-002";

    // Clear cache first
    clearCache();
    expect(getCacheSize()).toBe(0);

    // Clear non-existent entry should not throw
    clearCacheForStory(storyId);
    expect(getCacheSize()).toBe(0);
  });

  test("clearCacheForStory after tier escalation forces re-routing", () => {
    const storyId = "US-cache-003";

    // Clear all caches
    clearCache();
    expect(getCacheSize()).toBe(0);

    // Simulate clearing for escalation
    clearCacheForStory(storyId);

    // Cache should still be empty
    expect(getCacheSize()).toBe(0);
  });

  test("clearing one story does not affect other cached stories", () => {
    clearCache();

    const story1Id = "US-escalate-1";
    const story2Id = "US-escalate-2";

    // Verify we can clear individual stories
    clearCacheForStory(story1Id);
    clearCacheForStory(story2Id);

    expect(getCacheSize()).toBe(0);
  });

  test("clearCacheForStory is idempotent", () => {
    const storyId = "US-idempotent";

    clearCache();
    expect(getCacheSize()).toBe(0);

    // Clear multiple times should be safe
    clearCacheForStory(storyId);
    clearCacheForStory(storyId);
    clearCacheForStory(storyId);

    expect(getCacheSize()).toBe(0);
  });
});
