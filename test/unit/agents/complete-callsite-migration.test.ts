/**
 * Tests that acceptance pipeline call sites use the injected agentManager
 * rather than constructing one via createManager (which has been removed).
 * Part of #567 — Phase 4 adapter cleanup / ADR-018 Wave 1 migration.
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

describe("refineAcceptanceCriteria uses injected agentManager (#567 / ADR-018)", () => {
  test("uses context.agentManager when provided", async () => {
    const { refineAcceptanceCriteria, _refineDeps } = await import("../../../src/acceptance/refinement");
    const { mgr, callCount: mgrCallCount } = makeAgentManager();

    const savedAgentManager = _refineDeps.agentManager;
    _refineDeps.agentManager = undefined; // ensure only context.agentManager is used

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
    } finally {
      _refineDeps.agentManager = savedAgentManager;
    }
  });

  test("uses _refineDeps.agentManager when context.agentManager is absent", async () => {
    const { refineAcceptanceCriteria, _refineDeps } = await import("../../../src/acceptance/refinement");
    const { mgr, callCount: mgrCallCount } = makeAgentManager();

    const savedAgentManager = _refineDeps.agentManager;
    _refineDeps.agentManager = mgr;

    try {
      const ctx = {
        storyId: "us-001",
        featureName: "feature",
        workdir: "/tmp",
        codebaseContext: "ctx",
        config: DEFAULT_CONFIG,
        // agentManager absent
      };
      await refineAcceptanceCriteria(["AC-1: does something"], ctx);
      expect(mgrCallCount()).toBeGreaterThan(0);
    } finally {
      _refineDeps.agentManager = savedAgentManager;
    }
  });

  test("returns graceful fallback when both context.agentManager and _refineDeps.agentManager are absent", async () => {
    const { refineAcceptanceCriteria, _refineDeps } = await import("../../../src/acceptance/refinement");

    const savedAgentManager = _refineDeps.agentManager;
    _refineDeps.agentManager = undefined;

    try {
      const ctx = {
        storyId: "us-001",
        featureName: "feature",
        workdir: "/tmp",
        codebaseContext: "ctx",
        config: DEFAULT_CONFIG,
        // agentManager absent
      };
      const result = await refineAcceptanceCriteria(["AC-1: does something"], ctx);
      // Should not throw; returns fallback result
      expect(result).toBeDefined();
      expect(result.costUsd).toBe(0);
    } finally {
      _refineDeps.agentManager = savedAgentManager;
    }
  });
});

// ─── generateFromPRD ──────────────────────────────────────────────────────

describe("generateFromPRD uses injected agentManager (#567 / ADR-018)", () => {
  test("uses agentManager from options when provided", async () => {
    const { generateFromPRD, _generatorPRDDeps } = await import("../../../src/acceptance/generator");
    const { mgr, callCount: mgrCallCount } = makeAgentManager();

    const savedAgentManager = _generatorPRDDeps.agentManager;
    _generatorPRDDeps.agentManager = undefined; // ensure only options.agentManager is used

    // Also stub writeFile to prevent actual writes
    const savedWriteFile = _generatorPRDDeps.writeFile;
    (_generatorPRDDeps as { writeFile: unknown }).writeFile = mock(async () => {});

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
    } finally {
      _generatorPRDDeps.agentManager = savedAgentManager;
      (_generatorPRDDeps as { writeFile: unknown }).writeFile = savedWriteFile;
    }
  });
});
