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
// For complexity="complex", determineTestStrategy returns "three-session-tdd-lite" (#408)
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

function makeMockAgentManager(adapter: AgentAdapter & { complete: ReturnType<typeof mock> }) {
  return {
    getDefault: () => "mock",
    getAgent: (_name: string) => adapter,
    complete: mock(async (_prompt: string, _options?: any) => {
      const result = await adapter.complete(_prompt, _options);
      return result;
    }),
    completeAs: mock(async (_name: string, _prompt: string, _options?: any) => {
      const result = await adapter.complete(_prompt, _options);
      return result;
    }),
    run: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, fallbacks: [] })),
    runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, fallbacks: [] })),
    planAs: mock(async () => ({ result: { plan: "", estimatedCost: 0 }, fallbacks: [] })),
    decomposeAs: mock(async () => ({ result: { stories: [] }, fallbacks: [] })),
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    on: () => {},
  } as any;
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

    const mockAgentManager = {
      getDefault: () => "mock",
      getAgent: (_name: string) => mockAdapter,
      complete: mock(async (_prompt: string, _options?: any) => Promise.resolve(VALID_ROUTING_RESPONSE)),
      completeAs: mock(async (_name: string, _prompt: string, _options?: any) => Promise.resolve(VALID_ROUTING_RESPONSE)),
      run: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, fallbacks: [] })),
      runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, fallbacks: [] })),
      planAs: mock(async () => ({ result: { plan: "", estimatedCost: 0 }, fallbacks: [] })),
      decomposeAs: mock(async () => ({ result: { stories: [] }, fallbacks: [] })),
      isUnavailable: () => false,
      markUnavailable: () => {},
      reset: () => {},
      validateCredentials: async () => {},
      on: () => {},
    };

    const result = await classifyWithLlm(makeStory(), config, mockAgentManager as any);

    expect(result).not.toBeNull();
    expect(mockAgentManager.complete).toHaveBeenCalledTimes(1);
    expect(result?.complexity).toBe("simple");
    expect(result?.modelTier).toBe("fast");
    // testStrategy is derived by determineTestStrategy() from complexity (BUG-045)
    expect(result?.testStrategy).toBe("tdd-simple");
  });

  test("does NOT call _llmStrategyDeps.spawn when adapter is provided", async () => {
    const { classifyWithLlm, clearCache, _llmStrategyDeps } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    // Poison spawn so that any invocation fails the test
    const spawnSpy = mock(() => {
      throw new Error("_llmStrategyDeps.spawn must not be called when adapter is in context");
    });
    const originalSpawn = (_llmStrategyDeps as Record<string, unknown>).spawn;
    (_llmStrategyDeps as Record<string, unknown>).spawn = spawnSpy;

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);
    const mockAgentManager = makeMockAgentManager(mockAdapter);

    const result = await classifyWithLlm(makeStory("NO-SPAWN"), makeConfig(), mockAgentManager);

    expect(result).not.toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();

    (_llmStrategyDeps as Record<string, unknown>).spawn = originalSpawn;
  });

  test("passes the resolved model identifier to adapter.complete()", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);
    const config = makeConfig({ model: "balanced" });
    const mockAgentManager = makeMockAgentManager(mockAdapter);

    await classifyWithLlm(makeStory("MODEL-TEST"), config, mockAgentManager);

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
    const mockAgentManager = makeMockAgentManager(failingAdapter);

    await expect(
      classifyWithLlm(makeStory("FAIL-TEST"), makeConfig({ fallbackToKeywords: false }), mockAgentManager),
    ).rejects.toThrow("adapter.complete failed");
  });

  test("returns null (keyword fallback) when adapter.complete() fails and fallbackToKeywords is true", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const failingAdapter = makeMockAdapter("");
    failingAdapter.complete = mock(() => Promise.reject(new Error("LLM unavailable")));
    const mockAgentManager = makeMockAgentManager(failingAdapter);

    const result = await classifyWithLlm(
      makeStory("FALLBACK-TEST"),
      makeConfig({ fallbackToKeywords: true }),
      mockAgentManager,
    );
    expect(result).toBeNull();
  });

  test("returns complex routing decision from adapter response", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(COMPLEX_ROUTING_RESPONSE);
    const mockAgentManager = makeMockAgentManager(mockAdapter);

    const result = await classifyWithLlm(makeStory("COMPLEX"), makeConfig(), mockAgentManager);

    expect(result).not.toBeNull();
    expect(result?.complexity).toBe("complex");
    expect(result?.modelTier).toBe("powerful");
    expect(result?.testStrategy).toBe("three-session-tdd-lite"); // #408: complex → three-session-tdd-lite
  });

  test("caches decision on second call when cacheDecisions is true", async () => {
    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);
    const config = makeConfig({ cacheDecisions: true });
    const mockAgentManager = makeMockAgentManager(mockAdapter);

    const story = makeStory("CACHE-TEST");
    const result1 = await classifyWithLlm(story, config, mockAgentManager);
    const result2 = await classifyWithLlm(story, config, mockAgentManager);

    // Second call must use the cache — adapter invoked only once
    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);
    expect(result1).toEqual(result2);
  });

  test("agent manager resolved via _llmStrategyDeps.agentManager when not provided", async () => {
    const { classifyWithLlm, clearCache, _llmStrategyDeps } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(VALID_ROUTING_RESPONSE);
    const mockAgentManager = makeMockAgentManager(mockAdapter);
    const originalAgentManager = (_llmStrategyDeps as Record<string, unknown>).agentManager;
    (_llmStrategyDeps as Record<string, unknown>).agentManager = mockAgentManager;

    // Pass undefined manager — must fall back to _llmStrategyDeps.agentManager
    const result = await classifyWithLlm(makeStory("DEPS-TEST"), makeConfig(), undefined);

    expect(result).not.toBeNull();
    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);

    (_llmStrategyDeps as Record<string, unknown>).agentManager = originalAgentManager;
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
    const mockAgentManager = makeMockAgentManager(mockAdapter);

    const stories = [makeStory("BATCH-001"), makeStory("BATCH-002")];
    const decisions = await routeBatch(stories, { config, agentManager: mockAgentManager });

    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);
    expect(decisions.size).toBeGreaterThan(0);
  });

  test("does NOT call _llmStrategyDeps.spawn in routeBatch", async () => {
    const { routeBatch, clearCache, _llmStrategyDeps } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const spawnSpy = mock(() => {
      throw new Error("_llmStrategyDeps.spawn must not be called in routeBatch");
    });
    const originalSpawn = (_llmStrategyDeps as Record<string, unknown>).spawn;
    (_llmStrategyDeps as Record<string, unknown>).spawn = spawnSpy;

    const mockAdapter = makeMockAdapter(BATCH_RESPONSE);
    const config = makeConfig({ cacheDecisions: false });
    const mockAgentManager = makeMockAgentManager(mockAdapter);

    await routeBatch([makeStory("BATCH-001"), makeStory("BATCH-002")], { config, agentManager: mockAgentManager });

    expect(spawnSpy).not.toHaveBeenCalled();

    (_llmStrategyDeps as Record<string, unknown>).spawn = originalSpawn;
  });

  test("passes a prompt string as the first argument to adapter.complete()", async () => {
    const { routeBatch, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAdapter = makeMockAdapter(BATCH_RESPONSE);
    const config = makeConfig({ cacheDecisions: false });
    const mockAgentManager = makeMockAgentManager(mockAdapter);

    await routeBatch([makeStory("BATCH-001"), makeStory("BATCH-002")], { config, agentManager: mockAgentManager });

    const [prompt] = mockAdapter.complete.mock.calls[0] as [string, CompleteOptions?];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
