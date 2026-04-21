/**
 * Tests that acceptance pipeline call sites use agentManager.completeWithFallback()
 * when agentManager is injected, rather than calling adapter.complete() directly.
 * Part of #567 — Phase 4 adapter cleanup.
 */

import { describe, expect, mock, test } from "bun:test";
import type { IAgentManager } from "../../../src/agents/manager-types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { makeMockAgentManager } from "../../helpers";

const mockCompleteResult = { output: "ok", costUsd: 0.001, source: "exact" as const };

function makeAgentManager(): { mgr: IAgentManager; callCount: () => number } {
  let count = 0;
  const completeWithFallbackFn = async () => {
    count++;
    return { result: mockCompleteResult, fallbacks: [] };
  };
  const mgr = makeMockAgentManager({
    completeWithFallbackFn,
  }) as unknown as IAgentManager;
  Object.assign(mgr, {
    complete: completeWithFallbackFn,
    completeAs: async () => mockCompleteResult,
    runAs: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    getAgent: () => ({ run: async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCost: 0 }) } as any),
  });
  return { mgr, callCount: () => count };
}

// ─── refineAcceptanceCriteria ──────────────────────────────────────────────

describe("refineAcceptanceCriteria uses completeWithFallback when agentManager provided (#567)", () => {
  test("calls agentManager.completeWithFallback instead of createManager().complete when agentManager is provided", async () => {
    const { refineAcceptanceCriteria, _refineDeps } = await import("../../../src/acceptance/refinement");
    const { mgr, callCount: mgrCallCount } = makeAgentManager();
    let createManagerCalled = false;
    const savedCreateManager = _refineDeps.createManager;
    _refineDeps.createManager = mock(() => {
      createManagerCalled = true;
      return savedCreateManager(DEFAULT_CONFIG);
    });

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
      expect(createManagerCalled).toBe(false);
    } finally {
      _refineDeps.createManager = savedCreateManager;
    }
  });

  test("falls back to createManager().complete when agentManager is absent", async () => {
    const { refineAcceptanceCriteria, _refineDeps } = await import("../../../src/acceptance/refinement");
    const { mgr, callCount: mgrCallCount } = makeAgentManager();
    const savedCreateManager = _refineDeps.createManager;
    // Use a plain function instead of mock() to ensure the inner function runs
    let createManagerCalled = false;
    _refineDeps.createManager = function createManagerReplacement(config: any) {
      createManagerCalled = true;
      return mgr;
    };

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
      expect(createManagerCalled).toBe(true);
      expect(mgrCallCount()).toBeGreaterThan(0);
    } finally {
      _refineDeps.createManager = savedCreateManager;
    }
  });
});

// ─── generateFromPRD ──────────────────────────────────────────────────────

describe("generateFromPRD uses completeWithFallback when agentManager provided (#567)", () => {
  test("calls agentManager.completeWithFallback instead of createManager().complete when agentManager is provided", async () => {
    const { generateFromPRD, _generatorPRDDeps } = await import("../../../src/acceptance/generator");
    const { mgr, callCount: mgrCallCount } = makeAgentManager();
    const savedCreateManager = _generatorPRDDeps.createManager;
    let createManagerCalled = false;
    _generatorPRDDeps.createManager = mock((config: any) => {
      createManagerCalled = true;
      return savedCreateManager(config);
    });

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
      expect(createManagerCalled).toBe(false);
    } finally {
      _generatorPRDDeps.createManager = savedCreateManager;
    }
  });
});
