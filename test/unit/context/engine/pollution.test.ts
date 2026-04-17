/**
 * Amendment A AC-48: Pollution metrics
 *
 * Unit tests for pollution.ts:
 *   - computePollutionMetrics (aggregates counts from stored manifests)
 */

import { describe, expect, test } from "bun:test";
import { computePollutionMetrics } from "../../../../src/context/engine/pollution";
import type { StoredContextManifest } from "../../../../src/context/engine/manifest-store";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<StoredContextManifest["manifest"]> = {}): StoredContextManifest {
  return {
    featureId: "feat-001",
    stage: "context",
    path: "/project/.nax/features/feat-001/stories/US-001/context-manifest-context.json",
    manifest: {
      requestId: "req-1",
      stage: "context",
      totalBudgetTokens: 8000,
      usedTokens: 1000,
      includedChunks: ["feature-context:abc", "session-scratch:def"],
      excludedChunks: [],
      floorItems: ["feature-context:abc"],
      digestTokens: 50,
      buildMs: 100,
      ...overrides,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computePollutionMetrics
// ─────────────────────────────────────────────────────────────────────────────

describe("computePollutionMetrics", () => {
  test("returns zero metrics when no manifests provided", () => {
    const metrics = computePollutionMetrics([]);
    expect(metrics.droppedBelowMinScore).toBe(0);
    expect(metrics.staleChunksInjected).toBe(0);
    expect(metrics.contradictedChunks).toBe(0);
    expect(metrics.ignoredChunks).toBe(0);
    expect(metrics.pollutionRatio).toBe(0);
  });

  test("counts droppedBelowMinScore from excludedChunks", () => {
    const manifest = makeManifest({
      excludedChunks: [
        { id: "chunk-1", reason: "below-min-score" },
        { id: "chunk-2", reason: "below-min-score" },
        { id: "chunk-3", reason: "budget" },
      ],
    });
    const metrics = computePollutionMetrics([manifest]);
    expect(metrics.droppedBelowMinScore).toBe(2);
  });

  test("counts staleChunksInjected from staleChunks manifest field", () => {
    const manifest = makeManifest({
      staleChunks: ["feature-context:abc"],
    } as Partial<StoredContextManifest["manifest"]>);
    const metrics = computePollutionMetrics([manifest]);
    expect(metrics.staleChunksInjected).toBe(1);
  });

  test("counts contradictedChunks and ignoredChunks from chunkEffectiveness", () => {
    const manifest = makeManifest({
      chunkEffectiveness: {
        "feature-context:abc": { signal: "contradicted", evidence: "review finding contradicted" },
        "session-scratch:def": { signal: "ignored" },
        "static-rules:ghi": { signal: "followed" },
      },
    } as Partial<StoredContextManifest["manifest"]>);
    const metrics = computePollutionMetrics([manifest]);
    expect(metrics.contradictedChunks).toBe(1);
    expect(metrics.ignoredChunks).toBe(1);
  });

  test("computes pollutionRatio as (contradicted + ignored) / total included", () => {
    const manifest = makeManifest({
      includedChunks: ["a", "b", "c", "d"],
      chunkEffectiveness: {
        a: { signal: "contradicted" },
        b: { signal: "ignored" },
        c: { signal: "followed" },
        d: { signal: "unknown" },
      },
    } as Partial<StoredContextManifest["manifest"]>);
    const metrics = computePollutionMetrics([manifest]);
    // 2 (contradicted+ignored) / 4 included = 0.5
    expect(metrics.pollutionRatio).toBeCloseTo(0.5, 2);
  });

  test("aggregates across multiple manifests", () => {
    const m1 = makeManifest({
      excludedChunks: [{ id: "x", reason: "below-min-score" }],
      staleChunks: ["feature-context:abc"],
    } as Partial<StoredContextManifest["manifest"]>);
    const m2 = makeManifest({
      excludedChunks: [{ id: "y", reason: "below-min-score" }],
      chunkEffectiveness: { "session-scratch:def": { signal: "ignored" } },
    } as Partial<StoredContextManifest["manifest"]>);
    const metrics = computePollutionMetrics([m1, m2]);
    expect(metrics.droppedBelowMinScore).toBe(2);
    expect(metrics.staleChunksInjected).toBe(1);
    expect(metrics.ignoredChunks).toBe(1);
  });

  test("pollutionRatio is 0 when no included chunks", () => {
    const manifest = makeManifest({ includedChunks: [] });
    const metrics = computePollutionMetrics([manifest]);
    expect(metrics.pollutionRatio).toBe(0);
  });
});
