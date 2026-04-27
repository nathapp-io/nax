// RE-ARCH: keep
/**
 * LLM Routing Strategy Tests
 *
 * BUG-039: Stream drain fix — stdout/stderr cancelled before proc.kill() on timeout
 * Now also tests AA-003: adapter.complete() integration for timeout scenarios
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentAdapter, CompleteOptions } from "../../../../src/agents/types";
import { initLogger, resetLogger } from "../../../../src/logger";
import { makeAgentAdapter, makeNaxConfig } from "../../../helpers";

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

/** Creates a mock adapter that never resolves (simulates a hanging LLM call for timeout testing). */
function makeHangingAdapter() {
  return makeAgentAdapter({
    name: "hanging-mock",
    displayName: "Hanging Mock",
    binary: "hanging-mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 200_000,
      features: new Set(["tdd", "review", "refactor", "batch"]),
    },
    isInstalled: mock(() => Promise.resolve(true)),
    run: mock(() => Promise.reject(new Error("run() should not be called"))),
    buildCommand: mock(() => []),
    plan: mock(() => Promise.reject(new Error("plan() should not be called"))),
    decompose: mock(() => Promise.reject(new Error("decompose() should not be called"))),
    complete: mock((_prompt: string, _options?: CompleteOptions) => new Promise<string>(() => {})),
  });
}

function makeAgentManagerWithMocks({
  getDefaultAgent = "claude",
  getAgent,
  completeFn,
}: {
  getDefaultAgent?: string;
  getAgent?: (_name: string) => AgentAdapter;
  completeFn?: () => Promise<string>;
}) {
  const defaultAgent = getDefaultAgent;
  return {
    getDefault: () => defaultAgent,
    getAgent: getAgent ?? (() => ({} as AgentAdapter)),
    complete: completeFn
      ? mock(async (_prompt: string, _opts?: any) => {
          const result = await completeFn();
          return { output: result, costUsd: 0, source: "primary" as const };
        })
      : mock(async () => ({ output: "", costUsd: 0, source: "primary" as const })),
    completeAs: completeFn
      ? mock(async (_name: string, _prompt: string, _opts?: any) => {
          const result = await completeFn();
          return { output: result, costUsd: 0, source: "primary" as const };
        })
      : mock(async (_name: string, _prompt: string, _opts?: any) => ({ output: "", costUsd: 0, source: "primary" as const })),
    run: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, fallbacks: [] })),
    runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0, fallbacks: [] })),
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    on: () => {},
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
});

afterEach(() => {
  mock.restore();
  resetLogger();
});

// BUG-039 BUG-040
describe("adapter.complete() timeout is enforced and does not cause unhandled rejections", () => {
  test("timeout via adapter.complete() rejects within timeout window", async () => {
    const mockAdapter = makeHangingAdapter();
    const config = makeConfig({ timeoutMs: 30 });

    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAgentManager = makeAgentManagerWithMocks({
      getDefaultAgent: "test-agent",
      getAgent: (_name: string) => mockAdapter,
      completeFn: () => new Promise(() => {}),
    });

    const story = {
      id: "TEST-001",
      title: "Test story",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const startTime = Date.now();

    await expect(classifyWithLlm(story, config, mockAgentManager as any)).rejects.toThrow(/timeout/i);

    const elapsed = Date.now() - startTime;

    // Should resolve promptly — within 500ms of the 30ms timeout
    expect(elapsed).toBeLessThan(500);
  });

  test("no unhandled rejection when adapter.complete() times out", async () => {
    const unhandledRejections: Error[] = [];
    const handler = (event: PromiseRejectionEvent) => {
      unhandledRejections.push(event.reason as Error);
      event.preventDefault();
    };

    globalThis.addEventListener("unhandledrejection", handler);

    const mockAdapter = makeHangingAdapter();
    const config = makeConfig({ timeoutMs: 20, retries: 0 });

    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const mockAgentManager = makeAgentManagerWithMocks({
      getDefaultAgent: "test-agent",
      getAgent: (_name: string) => mockAdapter,
      completeFn: () => new Promise(() => {}),
    });

    const story = {
      id: "BUG040",
      title: "Bug test",
      description: "Test",
      acceptanceCriteria: ["AC1"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    await expect(classifyWithLlm(story, config, mockAgentManager as any)).rejects.toThrow(/timeout/i);

    // Give microtasks time to settle
    await Promise.resolve();

    globalThis.removeEventListener("unhandledrejection", handler);

    // No unhandled rejections should have occurred
    expect(unhandledRejections).toHaveLength(0);
  });

  test("adapter.complete() resolves on success path (no timeout)", async () => {
    const config = makeConfig({ timeoutMs: 5000 });

    const successAdapter = makeAgentAdapter({
      name: "success-mock",
      displayName: "Success Mock",
      binary: "success-mock",
      capabilities: {
        supportedTiers: ["fast", "balanced", "powerful"],
        maxContextTokens: 200_000,
        features: new Set(["tdd", "review", "refactor", "batch"]),
      },
      isInstalled: mock(() => Promise.resolve(true)),
      run: mock(() => Promise.reject(new Error("run() should not be called"))),
      buildCommand: mock(() => []),
      plan: mock(() => Promise.reject(new Error("plan() should not be called"))),
      decompose: mock(() => Promise.reject(new Error("decompose() should not be called"))),
      complete: mock(() =>
        Promise.resolve(
          JSON.stringify({
            complexity: "simple",
            modelTier: "fast",
            testStrategy: "tdd-simple",
            reasoning: "Simple test story",
          }),
        ),
      ),
    });

    const SUCCESS_RESPONSE = JSON.stringify({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "Simple test story",
    });

    const mockAgentManager = makeAgentManagerWithMocks({
      getDefaultAgent: "test-agent",
      getAgent: (_name: string) => successAdapter,
      completeFn: () => Promise.resolve(SUCCESS_RESPONSE),
    });

    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const story = {
      id: "TEST-002",
      title: "Add login button",
      description: "Simple button feature",
      acceptanceCriteria: ["Button renders"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const result = await classifyWithLlm(story, config, mockAgentManager as any);

    expect(result).not.toBeNull();
    expect(result?.complexity).toBe("simple");
    expect(mockAgentManager.complete).toHaveBeenCalledTimes(1);

    clearCache();
  });

  test("adapter.complete() timeout rejects within timeout window", async () => {
    const mockAdapter = makeHangingAdapter();
    const config = makeConfig({ timeoutMs: 50, retries: 0 });

    const mockAgentManager = makeAgentManagerWithMocks({
      getDefaultAgent: "test-agent",
      getAgent: (_name: string) => mockAdapter,
      completeFn: () => new Promise(() => {}),
    });

    const { classifyWithLlm, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

    const story = {
      id: "TEST-003",
      title: "Hanging story",
      description: "This will hang",
      acceptanceCriteria: ["AC"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const before = Date.now();
    await expect(classifyWithLlm(story, config, mockAgentManager as any)).rejects.toThrow();
    const after = Date.now();

    // Should complete well under 2s even though adapter.complete() never resolves
    expect(after - before).toBeLessThan(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache hit: testStrategy must be recomputed from complexity (TS-001 regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("LLM cache hit: testStrategy recomputed from complexity", () => {
  test("cache hit for simple story returns tdd-simple, not stale three-session-tdd-lite", async () => {
    const { classifyWithLlm, clearCache, injectCacheEntry } = await import(
      "../../../../src/routing/strategies/llm"
    );
    clearCache();

    const story = {
      id: "CACHE-SIMPLE-001",
      title: "Update button label",
      description: "Change the submit button text",
      acceptanceCriteria: ["Label reads 'Submit'"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    // Inject a stale cache entry that has the old strategy (pre TS-001)
    injectCacheEntry(story.id, {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "three-session-tdd-lite", // stale — was the old mapping
      reasoning: "stale cached result",
    });

    // Cache hit: adapter not needed since result comes from cache
    const result = await classifyWithLlm(story, makeConfig({ cacheDecisions: true }), undefined);

    // Must recompute: simple → tdd-simple (TS-001)
    expect(result?.complexity).toBe("simple");
    expect(result?.testStrategy).toBe("tdd-simple");

    clearCache();
  });

  // #408: medium now maps to tdd-simple (was three-session-tdd-lite)
  test("cache hit for medium story returns tdd-simple (#408)", async () => {
    const { classifyWithLlm, clearCache, injectCacheEntry } = await import(
      "../../../../src/routing/strategies/llm"
    );
    clearCache();

    const story = {
      id: "CACHE-MEDIUM-001",
      title: "Implement user settings page",
      description: "Build settings screen with multiple sections",
      acceptanceCriteria: ["AC1", "AC2", "AC3", "AC4", "AC5"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    injectCacheEntry(story.id, {
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "tdd-simple",
      reasoning: "cached medium result",
    });

    // Cache hit: adapter not needed since result comes from cache
    const result = await classifyWithLlm(story, makeConfig({ cacheDecisions: true }), undefined);

    // Must recompute: medium → tdd-simple (#408)
    expect(result?.complexity).toBe("medium");
    expect(result?.testStrategy).toBe("tdd-simple");

    clearCache();
  });
});
