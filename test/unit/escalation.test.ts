/**
 * Tests for src/execution/escalation.ts
 *
 * Covers: escalateTier, getTierConfig, calculateMaxIterations
 */

import { describe, expect, it } from "bun:test";
import type { TierConfig } from "../../src/config";
import { calculateMaxIterations, escalateTier, getTierConfig } from "../../src/execution/escalation";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const defaultTierOrder: TierConfig[] = [
  { tier: "fast", attempts: 5 },
  { tier: "balanced", attempts: 3 },
  { tier: "powerful", attempts: 2 },
];

const customTierOrder: TierConfig[] = [
  { tier: "haiku", attempts: 10 },
  { tier: "sonnet", attempts: 5 },
  { tier: "opus", attempts: 2 },
];

// ─────────────────────────────────────────────────────────────────────────────
// escalateTier
// ─────────────────────────────────────────────────────────────────────────────

describe("escalateTier", () => {
  it("returns next tier in order when not at max", () => {
    expect(escalateTier("fast", defaultTierOrder)).toBe("balanced");
    expect(escalateTier("balanced", defaultTierOrder)).toBe("powerful");
  });

  it("returns null when at max tier", () => {
    expect(escalateTier("powerful", defaultTierOrder)).toBeNull();
  });

  it("returns null when tier not found in order", () => {
    expect(escalateTier("unknown", defaultTierOrder)).toBeNull();
  });

  it("handles single-tier order", () => {
    const singleTier: TierConfig[] = [{ tier: "only", attempts: 10 }];
    expect(escalateTier("only", singleTier)).toBeNull();
  });

  it("works with custom tier names", () => {
    expect(escalateTier("haiku", customTierOrder)).toBe("sonnet");
    expect(escalateTier("sonnet", customTierOrder)).toBe("opus");
    expect(escalateTier("opus", customTierOrder)).toBeNull();
  });

  it("returns null for empty tier order", () => {
    expect(escalateTier("fast", [])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getTierConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("getTierConfig", () => {
  it("returns tier config when tier exists", () => {
    const config = getTierConfig("balanced", defaultTierOrder);
    expect(config).toEqual({ tier: "balanced", attempts: 3 });
  });

  it("returns undefined when tier not found", () => {
    expect(getTierConfig("unknown", defaultTierOrder)).toBeUndefined();
  });

  it("handles first tier", () => {
    const config = getTierConfig("fast", defaultTierOrder);
    expect(config).toEqual({ tier: "fast", attempts: 5 });
  });

  it("handles last tier", () => {
    const config = getTierConfig("powerful", defaultTierOrder);
    expect(config).toEqual({ tier: "powerful", attempts: 2 });
  });

  it("returns undefined for empty tier order", () => {
    expect(getTierConfig("fast", [])).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateMaxIterations
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateMaxIterations", () => {
  it("sums all tier attempts", () => {
    // 5 + 3 + 2 = 10
    expect(calculateMaxIterations(defaultTierOrder)).toBe(10);
  });

  it("handles single tier", () => {
    const singleTier: TierConfig[] = [{ tier: "only", attempts: 7 }];
    expect(calculateMaxIterations(singleTier)).toBe(7);
  });

  it("returns 0 for empty tier order", () => {
    expect(calculateMaxIterations([])).toBe(0);
  });

  it("handles large attempt counts", () => {
    const largeTiers: TierConfig[] = [
      { tier: "a", attempts: 100 },
      { tier: "b", attempts: 200 },
      { tier: "c", attempts: 150 },
    ];
    expect(calculateMaxIterations(largeTiers)).toBe(450);
  });

  it("handles zero attempts", () => {
    const zeroTiers: TierConfig[] = [
      { tier: "a", attempts: 0 },
      { tier: "b", attempts: 5 },
      { tier: "c", attempts: 0 },
    ];
    expect(calculateMaxIterations(zeroTiers)).toBe(5);
  });
});
