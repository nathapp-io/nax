// RE-ARCH: keep
/**
 * LLM Routing Strategy Tests
 *
 * BUG-039: Stream drain fix — stdout/stderr cancelled before proc.kill() on timeout
 * Now also tests AA-003: adapter.complete() integration for timeout scenarios
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
        timeoutMs: 50,
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

/** Creates a mock adapter that never resolves (simulates a hanging LLM call for timeout testing). */
function makeHangingAdapter() {
  return {
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
    complete: mock((_prompt: string, _options?: CompleteOptions) => new Promise<string>(() => {})), // never resolves
  } as AgentAdapter;
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

    const { llmStrategy, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

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

    await expect(llmStrategy.route(story, { config, adapter: mockAdapter })).rejects.toThrow(/timeout/i);

    const elapsed = Date.now() - startTime;

    // Should resolve promptly — within 500ms of the 30ms timeout
    expect(elapsed).toBeLessThan(500);
    expect(mockAdapter.complete).toHaveBeenCalledTimes(1);
  });

  test("no unhandled rejection when adapter.complete() times out", async () => {
    // Simulate timeout scenario:
    // 1. Adapter.complete() promise never resolves
    // 2. Timeout fires and rejects
    // 3. No unhandled rejection should occur

    const unhandledRejections: Error[] = [];
    const handler = (event: PromiseRejectionEvent) => {
      unhandledRejections.push(event.reason as Error);
      event.preventDefault();
    };

    globalThis.addEventListener("unhandledrejection", handler);

    const mockAdapter = makeHangingAdapter();
    const config = makeConfig({ timeoutMs: 20, retries: 0 });

    const { llmStrategy, clearCache } = await import("../../../../src/routing/strategies/llm");
    clearCache();

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

    await expect(llmStrategy.route(story, { config, adapter: mockAdapter })).rejects.toThrow(/timeout/i);

    // Give microtasks time to settle
    await Bun.sleep(50);

    globalThis.removeEventListener("unhandledrejection", handler);

    // No unhandled rejections should have occurred
    expect(unhandledRejections).toHaveLength(0);
  });

  test("adapter.complete() resolves on success path (no timeout)", async () => {
    const config = makeConfig({ timeoutMs: 5000 });

    // Adapter that resolves with valid JSON response
    const successAdapter = {
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
    } as AgentAdapter;

    const { llmStrategy, clearCache } = await import("../../../../src/routing/strategies/llm");
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

    const result = await llmStrategy.route(story, { config, adapter: successAdapter });

    expect(result).not.toBeNull();
    expect(result?.complexity).toBe("simple");
    expect(successAdapter.complete).toHaveBeenCalledTimes(1);

    clearCache();
  });

  test("adapter.complete() timeout rejects within timeout window", async () => {
    const mockAdapter = makeHangingAdapter();
    const config = makeConfig({ timeoutMs: 50, retries: 0 });

    const { llmStrategy, clearCache } = await import("../../../../src/routing/strategies/llm");
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
    await expect(llmStrategy.route(story, { config, adapter: mockAdapter })).rejects.toThrow();
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
    const { llmStrategy, clearCache, injectCacheEntry } = await import(
      "../../../../src/routing/strategies/llm"
    );
    clearCache();

    const config = makeConfig();

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

    const result = await llmStrategy.route(story, { config: makeConfig({ cacheDecisions: true }) });

    // Must recompute: simple → tdd-simple (TS-001)
    expect(result?.complexity).toBe("simple");
    expect(result?.testStrategy).toBe("tdd-simple");

    clearCache();
  });

  test("cache hit for medium story returns three-session-tdd-lite", async () => {
    const { llmStrategy, clearCache, injectCacheEntry } = await import(
      "../../../../src/routing/strategies/llm"
    );
    clearCache();

    const config = makeConfig();

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
      testStrategy: "three-session-tdd-lite",
      reasoning: "cached medium result",
    });

    const result = await llmStrategy.route(story, { config: makeConfig({ cacheDecisions: true }) });

    expect(result?.complexity).toBe("medium");
    expect(result?.testStrategy).toBe("three-session-tdd-lite");

    clearCache();
  });
});
