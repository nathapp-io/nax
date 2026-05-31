// RE-ARCH: keep
/**
 * Tests for src/execution/escalation.ts
 *
 * Covers: escalateTier, getTierConfig, calculateMaxIterations
 */

import { describe, expect, it } from "bun:test";
import type { TierConfig } from "../../../../src/config";
import { calculateMaxIterations, escalateTier, getTierConfig } from "../../../../src/execution/escalation";

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
  it("returns next tier object when not at max", () => {
    expect(escalateTier("fast", defaultTierOrder)).toEqual({ tier: "balanced", agent: undefined });
    expect(escalateTier("balanced", defaultTierOrder)).toEqual({ tier: "powerful", agent: undefined });
  });

  it.each([
    ["at max tier", "powerful", defaultTierOrder],
    ["tier not found in order", "unknown", defaultTierOrder],
    ["empty tier order", "fast", [] as TierConfig[]],
  ])("returns null when %s", (_label, tier, tierOrder) => {
    expect(escalateTier(tier, tierOrder)).toBeNull();
  });

  it("handles single-tier order", () => {
    const singleTier: TierConfig[] = [{ tier: "only", attempts: 10 }];
    expect(escalateTier("only", singleTier)).toBeNull();
  });

  it("works with custom tier names", () => {
    expect(escalateTier("haiku", customTierOrder)).toEqual({ tier: "sonnet", agent: undefined });
    expect(escalateTier("sonnet", customTierOrder)).toEqual({ tier: "opus", agent: undefined });
    expect(escalateTier("opus", customTierOrder)).toBeNull();
  });


  it("returns agent from next tier entry when agent field is set (AC-1)", () => {
    const tierOrder: TierConfig[] = [
      { tier: "fast", agent: "claude", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
    ];
    expect(escalateTier("fast", tierOrder)).toEqual({ tier: "balanced", agent: "claude" });
  });

  it("returns codex agent when next entry is codex/fast (AC-2)", () => {
    const tierOrder: TierConfig[] = [
      { tier: "fast", agent: "claude", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
      { tier: "fast", agent: "codex", attempts: 2 },
    ];
    expect(escalateTier("balanced", tierOrder)).toEqual({ tier: "fast", agent: "codex" });
  });

  it("returns null at last entry even with agent field (AC-3)", () => {
    const tierOrder: TierConfig[] = [
      { tier: "fast", agent: "claude", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
    ];
    expect(escalateTier("balanced", tierOrder)).toBeNull();
  });

  it("returns undefined agent when tierOrder entry has no agent field (AC-4)", () => {
    const tierOrder: TierConfig[] = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
    ];
    const result = escalateTier("fast", tierOrder);
    expect(result).toEqual({ tier: "balanced", agent: undefined });
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
  it.each<[string, TierConfig[], number]>([
    ["defaultTierOrder (5+3+2=10)", defaultTierOrder, 10],
    ["single tier (7)", [{ tier: "only", attempts: 7 }], 7],
    ["empty tier order (0)", [], 0],
    ["large counts (100+200+150=450)", [{ tier: "a", attempts: 100 }, { tier: "b", attempts: 200 }, { tier: "c", attempts: 150 }], 450],
    ["zero attempts (0+5+0=5)", [{ tier: "a", attempts: 0 }, { tier: "b", attempts: 5 }, { tier: "c", attempts: 0 }], 5],
  ])("sums attempts for %s", (_label, tierOrder, expected) => {
    expect(calculateMaxIterations(tierOrder)).toBe(expected);
  });
});
