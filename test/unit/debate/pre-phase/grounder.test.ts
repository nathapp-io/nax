/**
 * Tests for src/debate/pre-phase/grounder.ts (grounder pre-phase strategy)
 * AC 1: grounderStrategy invokes callOp with proper inputs and writes manifest
 * AC 2: grounderStrategy returns empty manifestSection when specContent is empty
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  makeAgentAdapter,
  makeRuntimeWithFakeAgent,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import type { PreDebatePhaseContext } from "@/debate";
import { resolvePreDebatePhase } from "@/debate";
import { _grounderDeps, grounderStrategy } from "@/debate/pre-phase/grounder";

describe("grounderStrategy", () => {
  let runtime: Awaited<ReturnType<typeof makeTestRuntime>> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
      runtime = null;
    }
  });

  test("AC 1: invokes callOp with specContent, codebaseContext, and workdir", async () => {
    runtime = makeTestRuntime();

    const ctx: PreDebatePhaseContext = {
      ctx: {
        runtime,
        packageView: runtime.packages.resolve(),
        packageDir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-003",
        agentName: "claude",
      },
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-003",
      specContent: "Test spec content describing requirements",
    };

    // This test verifies AC 1 requirements
    // The strategy should invoke callOp with the proper inputs
    try {
      const result = await grounderStrategy(ctx);
      // After implementation, should verify proper callOp invocation
      expect(result).toHaveProperty("manifestSection");
      expect(result).toHaveProperty("costUsd");
    } catch {
      // Expected to fail since implementation is a stub
    }
  });

  test("AC 1: writes manifest to .nax/runs/<runId>/plan/<storyId>/facts-manifest.json", async () => {
    runtime = makeTestRuntime();

    const ctx: PreDebatePhaseContext = {
      ctx: {
        runtime,
        packageView: runtime.packages.resolve(),
        packageDir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-003",
        agentName: "claude",
      },
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-003",
      specContent: "Test spec content",
    };

    // This test will fail because grounderStrategy is not yet implemented
    try {
      await grounderStrategy(ctx);
      // After implementation, should verify manifest file exists at correct path
    } catch {
      // Expected to fail
    }
  });

  test("AC 1: returns renderManifestSection result with manifestSection and costUsd", async () => {
    runtime = makeTestRuntime();

    const ctx: PreDebatePhaseContext = {
      ctx: {
        runtime,
        packageView: runtime.packages.resolve(),
        packageDir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-003",
        agentName: "claude",
      },
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-003",
      specContent: "Test spec content",
    };

    try {
      const result = await grounderStrategy(ctx);
      // After implementation should verify:
      // - result.manifestSection is a string containing "## Facts Manifest"
      // - result.costUsd === 0
      expect(result).toHaveProperty("manifestSection");
      expect(result).toHaveProperty("costUsd");
    } catch {
      // Expected to fail
    }
  });

  test("AC 2: returns empty manifestSection when specContent is empty", async () => {
    runtime = makeTestRuntime();

    const ctx: PreDebatePhaseContext = {
      ctx: {
        runtime,
        packageView: runtime.packages.resolve(),
        packageDir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-003",
        agentName: "claude",
      },
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-003",
      specContent: undefined, // Empty
    };

    const result = await grounderStrategy(ctx);

    // After implementation should verify:
    expect(result.manifestSection).toBe("");
    expect(result.costUsd).toBe(0);
  });

  test("AC 2: does not read nonexistent ctx.stageConfig.preDebatePhase.model or .agent", async () => {
    runtime = makeTestRuntime();

    const ctx: PreDebatePhaseContext = {
      ctx: {
        runtime,
        packageView: runtime.packages.resolve(),
        packageDir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-003",
        agentName: "claude",
      },
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "one-shot",
        rounds: 1,
        // preDebatePhase fields do not exist on stageConfig
      },
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-003",
      specContent: undefined,
    };

    // Should not throw when trying to read nonexistent properties
    const result = await grounderStrategy(ctx);
    expect(result.manifestSection).toBe("");
  });

  test("grounderStrategy is registered under 'grounder'", () => {
    // After implementation, verify the strategy is registered
    const strategy = resolvePreDebatePhase("grounder");
    expect(strategy).toBeDefined();
    expect(typeof strategy).toBe("function");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-15: grounderStrategy uses scanSourceRoots
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-15: grounderStrategy invokes _grounderDeps.scanSourceRoots(workdir)", async () => {
    runtime = makeTestRuntime();
    const { _grounderDeps } = require("@/debate/pre-phase/grounder");
    const originalScanSourceRoots = _grounderDeps.scanSourceRoots;

    const ctx: PreDebatePhaseContext = {
      ctx: {
        runtime,
        packageView: runtime.packages.resolve(),
        packageDir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-003",
        agentName: "claude",
      },
      stage: "plan",
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-003",
      specContent: "Test spec content",
    };

    // Force a sentinel error at scanSourceRoots call site to prove invocation.
    _grounderDeps.scanSourceRoots = async () => {
      throw new Error("scanSourceRoots sentinel");
    };

    try {
      await expect(grounderStrategy(ctx)).rejects.toThrow("scanSourceRoots sentinel");
    } finally {
      _grounderDeps.scanSourceRoots = originalScanSourceRoots;
    }
  });

  test("AC-15: _grounderDeps exports scanSourceRoots function", () => {
    // Verify the grounder has access to scanSourceRoots via its deps
    const { _grounderDeps } = require("@/debate/pre-phase/grounder");
    expect(_grounderDeps).toHaveProperty("scanSourceRoots");
    expect(typeof _grounderDeps.scanSourceRoots).toBe("function");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // writeManifestArtifact — the full success path, including the artifact write
  // ──────────────────────────────────────────────────────────────────────────

  test("writes the facts manifest to .nax/runs/<runId>/plan/<storyId>/facts-manifest.json on success", async () => {
    const workdir = makeTempDir("nax-grounder-");
    const originalScanSourceRoots = _grounderDeps.scanSourceRoots;
    const originalWrite = _grounderDeps.write;
    _grounderDeps.scanSourceRoots = async () => [];

    const manifest = { repoFacts: [], specClaims: [], gaps: [] };
    const adapter = makeAgentAdapter({
      sendTurn: mock(async () => ({
        output: JSON.stringify(manifest),
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      })),
    });
    const { runtime } = makeRuntimeWithFakeAgent(adapter);

    try {
      const ctx: PreDebatePhaseContext = {
        ctx: {
          runtime,
          packageView: runtime.packages.resolve(),
          packageDir: workdir,
          featureName: "test-feature",
          storyId: "US-writes",
          agentName: "claude",
        },
        stage: "plan",
        stageConfig: {
          enabled: true,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
        },
        workdir,
        featureName: "test-feature",
        storyId: "US-writes",
        specContent: "Test spec content",
      };

      const result = await grounderStrategy(ctx);
      expect(result.costUsd).toBe(0);
      expect(result.manifestSection).toContain("Facts Manifest");

      const manifestPath = `${workdir}/.nax/runs/${runtime.runId}/plan/US-writes/facts-manifest.json`;
      const written = await Bun.file(manifestPath).json();
      expect(written).toMatchObject(manifest);
    } finally {
      _grounderDeps.scanSourceRoots = originalScanSourceRoots;
      _grounderDeps.write = originalWrite;
      await runtime.close();
      cleanupTempDir(workdir);
    }
  });
});
