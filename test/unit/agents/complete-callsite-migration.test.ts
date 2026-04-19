/**
 * Tests that acceptance pipeline call sites use agentManager.completeWithFallback()
 * when agentManager is injected, rather than calling adapter.complete() directly.
 * Part of #567 — Phase 4 adapter cleanup.
 */

import { describe, expect, mock, test } from "bun:test";
import type { IAgentManager } from "../../../src/agents/manager-types";
import type { AgentAdapter } from "../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

// ─── Shared mock helpers ───────────────────────────────────────────────────

const mockCompleteResult = { output: "ok", costUsd: 0.001, source: "exact" as const };

function makeAgentManager(): { mgr: IAgentManager; callCount: () => number } {
  let count = 0;
  const mgr = {
    getDefault: () => "claude",
    completeWithFallback: mock(async () => {
      count++;
      return { result: mockCompleteResult, fallbacks: [] };
    }),
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: mock(async () => ({
      result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 },
      fallbacks: [],
    })),
    events: { on: () => {} },
  } as unknown as IAgentManager;
  return { mgr, callCount: () => count };
}

function makeAdapter(): { adapter: AgentAdapter; callCount: () => number } {
  let count = 0;
  const adapter = {
    complete: mock(async () => {
      count++;
      return mockCompleteResult;
    }),
  } as unknown as AgentAdapter;
  return { adapter, callCount: () => count };
}

// ─── refineAcceptanceCriteria ──────────────────────────────────────────────

describe("refineAcceptanceCriteria uses completeWithFallback when agentManager provided (#567)", () => {
  test("calls agentManager.completeWithFallback instead of adapter.complete", async () => {
    const { refineAcceptanceCriteria, _refineDeps } = await import("../../../src/acceptance/refinement");
    const { mgr, callCount: mgrCallCount } = makeAgentManager();
    const { adapter, callCount: adapterCallCount } = makeAdapter();

    const originalAdapter = _refineDeps.adapter;
    _refineDeps.adapter = adapter as typeof _refineDeps.adapter;

    try {
      const ctx = {
        storyId: "us-001",
        featureName: "feature",
        workdir: "/tmp",
        codebaseContext: "ctx",
        config: DEFAULT_CONFIG,
        agentManager: mgr,
      };
      await refineAcceptanceCriteria(["AC-1: does something"], ctx);
      expect(mgrCallCount()).toBeGreaterThan(0);
      expect(adapterCallCount()).toBe(0);
    } finally {
      _refineDeps.adapter = originalAdapter;
    }
  });

  test("falls back to adapter.complete when agentManager is absent", async () => {
    const { refineAcceptanceCriteria, _refineDeps } = await import("../../../src/acceptance/refinement");
    const { adapter, callCount: adapterCallCount } = makeAdapter();

    const originalAdapter = _refineDeps.adapter;
    _refineDeps.adapter = adapter as typeof _refineDeps.adapter;

    try {
      const ctx = {
        storyId: "us-001",
        featureName: "feature",
        workdir: "/tmp",
        codebaseContext: "ctx",
        config: DEFAULT_CONFIG,
        // agentManager absent
      };
      await refineAcceptanceCriteria(["AC-1: does something"], ctx).catch(() => {});
      expect(adapterCallCount()).toBeGreaterThan(0);
    } finally {
      _refineDeps.adapter = originalAdapter;
    }
  });
});

// ─── generateFromPRD ──────────────────────────────────────────────────────

describe("generateFromPRD uses completeWithFallback when agentManager provided (#567)", () => {
  test("calls agentManager.completeWithFallback instead of adapter.complete", async () => {
    const { generateFromPRD, _generatorPRDDeps } = await import("../../../src/acceptance/generator");
    const { mgr, callCount: mgrCallCount } = makeAgentManager();
    const { adapter, callCount: adapterCallCount } = makeAdapter();

    const originalAdapter = _generatorPRDDeps.adapter;
    _generatorPRDDeps.adapter = adapter as typeof _generatorPRDDeps.adapter;

    try {
      const options = {
        featureName: "feature",
        workdir: "/tmp",
        featureDir: "/tmp/.nax/features/feature",
        codebaseContext: "ctx",
        modelTier: "fast" as const,
        modelDef: { provider: "anthropic" as const, model: "claude-haiku-4-5" },
        config: DEFAULT_CONFIG,
        agentManager: mgr,
      };
      const dummyCriteria = [{ original: "AC-1", refined: "returns ok", testable: true, storyId: "us-001" }];
      await generateFromPRD([], dummyCriteria, options).catch(() => {});
      expect(mgrCallCount()).toBeGreaterThan(0);
      expect(adapterCallCount()).toBe(0);
    } finally {
      _generatorPRDDeps.adapter = originalAdapter;
    }
  });
});
