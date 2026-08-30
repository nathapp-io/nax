// RE-ARCH: keep
/**
 * LLM Routing Cache Tests
 *
 * classifyWithLlm() and routeBatch() were removed in ADR-019 Phase B1.
 * Router.ts now invokes classifyRouteOp / classifyRouteBatchOp via callOp.
 *
 * This file now tests only the cache utilities that remain in llm.ts / llm-cache.ts,
 * plus the TS-001 / #408 regression tests for cache-hit testStrategy recomputation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory } from "@test/helpers";
import { initLogger, resetLogger } from "@/logger";
import { buildBatchRoutingPromptAsync, buildRoutingPromptAsync } from "@/routing/strategies/llm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return makeNaxConfig({
    routing: {
      strategy: "llm",
      llm: {
        mode: "per-story",
        timeoutMs: 50,
        retries: 0,
        retryDelayMs: 0,
        fallbackToKeywords: false,
        cacheDecisions: false,
        model: "fast",
        ...overrides,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetLogger();
  initLogger({ level: "silent" });
});

afterEach(() => {
  resetLogger();
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache utility tests
// ─────────────────────────────────────────────────────────────────────────────

describe("LLM routing cache utilities", () => {
  // Each test builds its own Map — the cache is run-scoped (NaxRuntime.routingCache,
  // BUG-19), not a module-level singleton, so there's nothing to reset between tests.

  test("clearCache empties the cache", async () => {
    const { clearCache, getCacheSize, injectCacheEntry } = await import("@/routing/strategies/llm");
    const cache = new Map();
    injectCacheEntry(cache, "CACHE-UTIL-001", {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "test",
    });
    expect(getCacheSize(cache)).toBeGreaterThan(0);
    clearCache(cache);
    expect(getCacheSize(cache)).toBe(0);
  });

  test("clearCacheForStory removes only that entry", async () => {
    const { getCacheSize, injectCacheEntry, clearCacheForStory } = await import("@/routing/strategies/llm");
    const cache = new Map();
    injectCacheEntry(cache, "CACHE-A", {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "a",
    });
    injectCacheEntry(cache, "CACHE-B", {
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "tdd-simple",
      reasoning: "b",
    });
    expect(getCacheSize(cache)).toBe(2);
    clearCacheForStory(cache, "CACHE-A");
    expect(getCacheSize(cache)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG-033 regression — config shape accepts retry and timeout fields
// ─────────────────────────────────────────────────────────────────────────────

describe("LLM routing config shape accepts retry and timeout fields", () => {
  test("config with retries and retryDelayMs is well-formed", () => {
    const config = makeConfig({ retries: 2, retryDelayMs: 500 });
    expect(config.routing.llm?.retries).toBe(2);
    expect(config.routing.llm?.retryDelayMs).toBe(500);
  });

  test("retries defaults to undefined when unset", () => {
    const config = makeNaxConfig({
      routing: {
        ...makeNaxConfig({}).routing,
        llm: { mode: "per-story" as const, fallbackToKeywords: true, cacheDecisions: true },
      },
    });
    expect(config.routing.llm?.retries).toBeUndefined();
  });

  test("effective timeout defaults to 30000ms when timeoutMs is unset", () => {
    const config = makeNaxConfig({
      routing: {
        ...makeNaxConfig({}).routing,
        llm: { mode: "per-story" as const, fallbackToKeywords: true, cacheDecisions: true },
      },
    });
    const effectiveTimeout = config.routing.llm?.timeoutMs ?? 30000;
    expect(effectiveTimeout).toBe(30000);
  });

  test("retries: 0 disables retry (single attempt only)", () => {
    const config = makeConfig({ retries: 0 });
    expect(config.routing.llm?.retries).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRoutingPromptAsync", () => {
  test("includes the story's title, description, acceptance criteria, and tags", async () => {
    const story = makeStory({
      title: "Add login form",
      description: "Users can sign in with email and password",
      acceptanceCriteria: ["Shows an error on invalid credentials", "Redirects on success"],
      tags: ["auth", "frontend"],
    });

    const prompt = await buildRoutingPromptAsync(story);

    expect(prompt).toContain("Add login form");
    expect(prompt).toContain("Users can sign in with email and password");
    expect(prompt).toContain("1. Shows an error on invalid credentials");
    expect(prompt).toContain("2. Redirects on success");
    expect(prompt).toContain("auth, frontend");
    expect(prompt).toContain("RoutingDecision");
    expect(prompt).toContain("fast");
    expect(prompt).toContain("balanced");
    expect(prompt).toContain("powerful");
  });

  test("handles a story with no acceptance criteria or tags", async () => {
    const story = makeStory({ acceptanceCriteria: [], tags: [] });

    const prompt = await buildRoutingPromptAsync(story);

    expect(prompt).toContain("Acceptance Criteria:");
    expect(prompt).toContain("Tags: ");
  });
});

describe("buildBatchRoutingPromptAsync", () => {
  test("includes every story's id, title, description, and criteria numbered per-story", async () => {
    const storyA = makeStory({
      id: "US-001",
      title: "Story A",
      description: "First story",
      acceptanceCriteria: ["A does X"],
      tags: ["a"],
    });
    const storyB = makeStory({
      id: "US-002",
      title: "Story B",
      description: "Second story",
      acceptanceCriteria: ["B does Y", "B does Z"],
      tags: [],
    });

    const prompt = await buildBatchRoutingPromptAsync([storyA, storyB]);

    expect(prompt).toContain("1. US-001: Story A");
    expect(prompt).toContain("First story");
    expect(prompt).toContain("1. A does X");
    expect(prompt).toContain("2. US-002: Story B");
    expect(prompt).toContain("Second story");
    expect(prompt).toContain("1. B does Y");
    expect(prompt).toContain("2. B does Z");
    expect(prompt).toContain("BatchRoutingDecision");
  });

  test("handles an empty story list", async () => {
    const prompt = await buildBatchRoutingPromptAsync([]);
    expect(prompt).toContain("BatchRoutingDecision");
  });
});
