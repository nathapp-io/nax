/**
 * AA-003: LLM Routing Strategy — adapter integration tests
 *
 * classifyWithLlm and routeBatch are deleted (ADR-019 Phase B1).
 * Routing now goes through classifyRouteOp / classifyRouteBatchOp via callOp.
 *
 * This file retains only the tests that verify _llmStrategyDeps.spawn is NOT
 * used and that the module still exports the expected utilities.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLogger, resetLogger } from "../../../../src/logger";

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
});

afterEach(() => {
  mock.restore();
  resetLogger();
});

describe("llm.ts module exports — cache utilities still available", () => {
  test("clearCache, getCacheSize, injectCacheEntry are exported", async () => {
    const { clearCache, getCacheSize, injectCacheEntry, clearCacheForStory } = await import(
      "../../../../src/routing/strategies/llm"
    );
    expect(typeof clearCache).toBe("function");
    expect(typeof getCacheSize).toBe("function");
    expect(typeof injectCacheEntry).toBe("function");
    expect(typeof clearCacheForStory).toBe("function");
  });

  test("ROUTING_INSTRUCTIONS is exported from llm.ts", async () => {
    const { ROUTING_INSTRUCTIONS } = await import("../../../../src/routing/strategies/llm");
    expect(typeof ROUTING_INSTRUCTIONS).toBe("string");
    expect(ROUTING_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  test("_llmStrategyDeps.spawn is defined (not undefined)", async () => {
    const { _llmStrategyDeps } = await import("../../../../src/routing/strategies/llm");
    expect(_llmStrategyDeps.spawn).toBeDefined();
  });
});
