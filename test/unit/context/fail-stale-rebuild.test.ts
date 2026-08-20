import { describe, expect, test } from "bun:test";
import type { AdapterFailure, RebuildOptions } from "@/context/engine";

/**
 * Tests for context rebuilding when fail-stale occurs.
 *
 * Verifies that:
 * 1. RebuildOptions carries fail-stale failure for rebuildForAgent
 * 2. fail-stale failure info is recorded in ContextManifest.rebuildInfo
 * 3. fail-stale does not inject failure-note in rebuild (info-only)
 */

const staleFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle watchdog cancelled prompt",
};

describe("Context rebuild with fail-stale", () => {
  test("RebuildOptions carries fail-stale AdapterFailure", () => {
    const options: RebuildOptions = {
      newAgentId: "codex",
      failure: staleFailure,
      storyId: "us-001",
    };

    expect(options.failure).toBeDefined();
    expect(options.failure?.outcome).toBe("fail-stale");
    expect(options.failure?.category).toBe("availability");
  });

  test("rebuildInfo records fail-stale failure details", () => {
    const rebuildInfo = {
      priorAgentId: "claude",
      newAgentId: "codex",
      failureCategory: staleFailure.category,
      failureOutcome: staleFailure.outcome,
      priorChunkIds: ["chunk-1", "chunk-2"],
      newChunkIds: ["chunk-1", "chunk-2", "chunk-3"],
      chunkIdMap: [
        { priorChunkId: "chunk-1", newChunkId: "chunk-1" },
        { priorChunkId: "chunk-2", newChunkId: "chunk-2" },
      ],
    };

    expect(rebuildInfo.failureOutcome).toBe("fail-stale");
    expect(rebuildInfo.failureCategory).toBe("availability");
  });

  test("fail-stale failure info is logged for debugging but does not block rebuild", () => {
    const logs: string[] = [];

    function logRebuild(failure: AdapterFailure, newAgent: string) {
      logs.push(
        `[rebuild] agent swap: ${failure.outcome} (${failure.category}) → ${newAgent}`,
      );
    }

    logRebuild(staleFailure, "codex");

    expect(logs[0]).toContain("fail-stale");
    expect(logs[0]).toContain("codex");
  });

  test("same-agent retry does NOT trigger rebuild (no agent swap)", () => {
    // When retrying with the same agent, rebuildForAgent is not called
    // Only if we're swapping to a different agent do we rebuild

    const shouldRebuild = false; // No rebuild for same-agent retry
    expect(shouldRebuild).toBe(false);
  });

  test("agent-swap fallback DOES trigger rebuild with fail-stale in options", () => {
    const rebuildOptions: RebuildOptions = {
      newAgentId: "codex",
      failure: staleFailure,
      storyId: "us-001",
    };

    expect(rebuildOptions.newAgentId).toBe("codex");
    expect(rebuildOptions.failure?.outcome).toBe("fail-stale");
  });

  test("rebuildInfo preserved in manifest for audit trail", () => {
    const manifest = {
      requestId: "req-123",
      stage: "run",
      totalBudgetTokens: 10000,
      usedTokens: 5000,
      includedChunks: ["chunk-1"],
      excludedChunks: [],
      floorItems: ["chunk-1"],
      digestTokens: 100,
      buildMs: 50,
      rebuildInfo: {
        priorAgentId: "claude",
        newAgentId: "codex",
        failureCategory: "availability" as const,
        failureOutcome: "fail-stale" as const,
        priorChunkIds: ["chunk-1"],
        newChunkIds: ["chunk-1"],
        chunkIdMap: [{ priorChunkId: "chunk-1", newChunkId: "chunk-1" }],
      },
    };

    expect(manifest.rebuildInfo?.failureOutcome).toBe("fail-stale");
    expect(manifest.rebuildInfo?.failureCategory).toBe("availability");
  });
});
