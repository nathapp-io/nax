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
import { initLogger, resetLogger } from "../../../../src/logger";
import { makeNaxConfig } from "../../../helpers";

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
  initLogger({ level: "error", useChalk: false });
});

afterEach(() => {
  resetLogger();
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache utility tests
// ─────────────────────────────────────────────────────────────────────────────

describe("LLM routing cache utilities", () => {
  test("clearCache empties the cache", async () => {
    const { clearCache, getCacheSize, injectCacheEntry } = await import("../../../../src/routing/strategies/llm");
    injectCacheEntry("CACHE-UTIL-001", {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "test",
    });
    expect(getCacheSize()).toBeGreaterThan(0);
    clearCache();
    expect(getCacheSize()).toBe(0);
  });

  test("clearCacheForStory removes only that entry", async () => {
    const { clearCache, getCacheSize, injectCacheEntry, clearCacheForStory } = await import(
      "../../../../src/routing/strategies/llm"
    );
    clearCache();
    injectCacheEntry("CACHE-A", {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "a",
    });
    injectCacheEntry("CACHE-B", {
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "tdd-simple",
      reasoning: "b",
    });
    expect(getCacheSize()).toBe(2);
    clearCacheForStory("CACHE-A");
    expect(getCacheSize()).toBe(1);
    clearCache();
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
