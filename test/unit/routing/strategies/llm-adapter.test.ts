/**
 * AA-003: LLM Routing Strategy — adapter.complete() integration tests
 *
 * Tests that classifyWithLlm and routeBatch use adapter.complete() instead of
 * Bun.spawn(['claude', ...]) directly.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentAdapter, CompleteOptions } from "../../../../src/agents/types";
import type { NaxConfig } from "../../../../src/config";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import { initLogger, resetLogger } from "../../../../src/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<NaxConfig["routing"]["llm"]> = {}): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    routing: {
      ...DEFAULT_CONFIG.routing,
      strategy: "llm",
      llm: {
        mode: "per-story",
        timeoutMs: 5000,
        retries: 0,
        retryDelayMs: 0,
        fallbackToKeywords: false,
        cacheDecisions: false,
        model: "fast",
        ...overrides,
      },
    },
  } as NaxConfig;
}

// Note: parseRoutingResponse derives testStrategy via determineTestStrategy() (BUG-045),
// so the testStrategy field in the adapter response is ignored.
// For complexity="simple", determineTestStrategy returns "tdd-simple"
// For complexity="complex", determineTestStrategy returns "three-session-tdd" (by default)
const VALID_ROUTING_RESPONSE = JSON.stringify({
  complexity: "simple",
  modelTier: "fast",
  reasoning: "Simple test story",
});

const COMPLEX_ROUTING_RESPONSE = JSON.stringify({
  complexity: "complex",
  modelTier: "powerful",
  reasoning: "Complex feature requiring expert model",
});

function makeStory(id = "TEST-001") {
  return {
    id,
    title: "Test story",
    description: "A test story for routing",
    acceptanceCriteria: ["AC1"],
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makeMockAdapter(responseText: string): AgentAdapter & { complete: ReturnType<typeof mock> } {
  const completeMock = mock((_prompt: string, _options?: CompleteOptions) => Promise.resolve(responseText));
  return {
    name: "mock",
    displayName: "Mock Adapter",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 200_000,
      features: new Set(["tdd", "review", "refactor", "batch"]),
    },
    isInstalled: mock(() => Promise.resolve(true)),
    run: mock(() => Promise.reject(new Error("run() should not be called in routing tests"))),
    buildCommand: mock(() => []),
    plan: mock(() => Promise.reject(new Error("plan() should not be called in routing tests"))),
    decompose: mock(() => Promise.reject(new Error("decompose() should not be called in routing tests"))),
    complete: completeMock,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
});

afterEach(() => {
  mock.restore();
  resetLogger();
});

// ---------------------------------------------------------------------------
// Per-story routing via adapter
// ---------------------------------------------------------------------------

describe("AA-003: classifyWithLlm() uses adapter.complete()", () => {
  test("calls adapter.complete() when adapter is provided", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);
    const config = makeConfig();

    const result = await classifyWithLlm(makeStory(), config, mockAdapter);

    expect(result).not.toBeNull();
    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);
    expect(result?.complexity).toBe("simple");
    expect(result?.modelTier).toBe("fast");
    // testStrategy is derived by determineTestStrategy() from complexity (BUG-045)
    expect(result?.testStrategy).toBe("tdd-simple");
  });

  test("does NOT call _deps.spawn when adapter is provided", async () => {
    const { classifyWithLlm, clearCache, _deps } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    // Poison spawn so that any invocation fails the test
    const spawnSpy = mock(() => {
      throw new Error("_deps.spawn must not be called when adapter is in context");
    });
    const originalSpawn = (_deps as Record<string, unknown>).spawn;
    (_deps as Record<string, unknown>).spawn = spawnSpy;

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);

    const result = await classifyWithLlm(makeStory("NO-SPAWN"), makeConfig(), mockAdapter);

    expect(result).not.toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();

    (_deps as Record<string, unknown>).spawn = originalSpawn;
  });

  test("passes the resolved model identifier to adapter.complete()", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);
    const config = makeConfig({ model: "balanced" });

    await classifyWithLlm(makeStory("MODEL-TEST"), config, mockAdapter);

    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);
    const [_prompt, opts] = mockAdapter.complete.mock.calls[0] as [string, CompleteOptions?];
    // Resolved model should be passed so the adapter can honour it
    expect(opts?.model).toBeDefined();
    expect(typeof opts?.model).toBe("string");
  });

  test("propagates error from adapter.complete() when fallbackToKeywords is false", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const failingAdapter = makeMockAdapter("");
    failingAdapter.complete = mock(() => Promise.reject(new Error("adapter.complete failed")));

    await expect(
      classifyWithLlm(makeStory("FAIL-TEST"), makeConfig({ fallbackToKeywords: false }), failingAdapter),
    ).rejects.toThrow("adapter.complete failed");
  });

  test("returns null (keyword fallback) when adapter.complete() fails and fallbackToKeywords is true", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const failingAdapter = makeMockAdapter("");
    failingAdapter.complete = mock(() => Promise.reject(new Error("LLM unavailable")));

    const result = await classifyWithLlm(
      makeStory("FALLBACK-TEST"),
      makeConfig({ fallbackToKeywords: true }),
      failingAdapter,
    );
    expect(result).toBeNull();
  });

  test("returns complex routing decision from adapter response", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(COMPLEX_ROUTING_RESPONSE);

    const result = await classifyWithLlm(makeStory("COMPLEX"), makeConfig(), mockAdapter);

    expect(result).not.toBeNull();
    expect(result?.complexity).toBe("complex");
    expect(result?.modelTier).toBe("powerful");
    expect(result?.testStrategy).toBe("three-session-tdd");
  });

  test("caches decision on second call when cacheDecisions is true", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);
    const config = makeConfig({ cacheDecisions: true });

    const story = makeStory("CACHE-TEST");
    const result1 = await classifyWithLlm(story, config, mockAdapter);
    const result2 = await classifyWithLlm(story, config, mockAdapter);

    // Second call must use the cache — adapter invoked only once
    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);
    expect(result1).toEqual(result2);
  });

  test("adapter resolved via _deps.adapter when not provided", async () => {
    const { classifyWithLlm, clearCache, _deps } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);
    const originalAdapter = (_deps as Record<string, unknown>).adapter;
    (_deps as Record<string, unknown>).adapter = mockAdapter;

    // Pass undefined adapter — must fall back to _deps.adapter
    const result = await classifyWithLlm(makeStory("DEPS-TEST"), makeConfig(), undefined);

    expect(result).not.toBeNull();
    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);

    (_deps as Record<string, unknown>).adapter = originalAdapter;
  });
});

// ---------------------------------------------------------------------------
// Batch routing via adapter
// ---------------------------------------------------------------------------

describe("AA-003: routeBatch uses adapter.complete()", () => {
  const BATCH_RESPONSE = JSON.stringify([
    { id: "BATCH-001", complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "Simple" },
    {
      id: "BATCH-002",
      complexity: "complex",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "Complex",
    },
  ]);

  test("calls adapter.complete() once for the entire batch", async () => {
    const { routeBatch, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(BATCH_RESPONSE);
    const config = makeConfig({ cacheDecisions: false });

    const stories = [makeStory("BATCH-001"), makeStory("BATCH-002")];
    const decisions = await routeBatch(stories, { config, adapter: mockAdapter });

    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);
    expect(decisions.size).toBeGreaterThan(0);
  });

  test("does NOT call _deps.spawn in routeBatch", async () => {
    const { routeBatch, clearCache, _deps } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const spawnSpy = mock(() => {
      throw new Error("_deps.spawn must not be called in routeBatch");
    });
    const originalSpawn = (_deps as Record<string, unknown>).spawn;
    (_deps as Record<string, unknown>).spawn = spawnSpy;

    const mockAdapter = makeMockAdapter(BATCH_RESPONSE);
    const config = makeConfig({ cacheDecisions: false });

    await routeBatch([makeStory("BATCH-001"), makeStory("BATCH-002")], { config, adapter: mockAdapter });

    expect(spawnSpy).not.toHaveBeenCalled();

    (_deps as Record<string, unknown>).spawn = originalSpawn;
  });

  test("passes a prompt string as the first argument to adapter.complete()", async () => {
    const { routeBatch, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(BATCH_RESPONSE);
    const config = makeConfig({ cacheDecisions: false });

    await routeBatch([makeStory("BATCH-001"), makeStory("BATCH-002")], { config, adapter: mockAdapter });

    const [prompt] = mockAdapter.complete.mock.calls[0] as [string, CompleteOptions?];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
