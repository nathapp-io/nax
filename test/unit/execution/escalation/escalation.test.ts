// RE-ARCH: keep
/**
 * Tests for src/execution/escalation.ts
 *
 * Covers: escalateTier, getTierConfig, calculateMaxIterations
 */

import { describe, expect, it, test } from "bun:test";
import type { TierConfig } from "@/config";
import { calculateMaxIterations, escalateTier, getTierConfig } from "@/execution/escalation";

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
    expect(escalateTier({ tier: "fast" }, defaultTierOrder)).toEqual({ tier: "balanced", agent: undefined });
    expect(escalateTier({ tier: "balanced" }, defaultTierOrder)).toEqual({ tier: "powerful", agent: undefined });
  });

  it.each([
    ["at max tier", "powerful", defaultTierOrder],
    ["tier not found in order", "unknown", defaultTierOrder],
    ["empty tier order", "fast", [] as TierConfig[]],
  ])("returns null when %s", (_label, tier, tierOrder) => {
    expect(escalateTier({ tier }, tierOrder)).toBeNull();
  });

  it("handles single-tier order", () => {
    const singleTier: TierConfig[] = [{ tier: "only", attempts: 10 }];
    expect(escalateTier({ tier: "only" }, singleTier)).toBeNull();
  });

  it("works with custom tier names", () => {
    expect(escalateTier({ tier: "haiku" }, customTierOrder)).toEqual({ tier: "sonnet", agent: undefined });
    expect(escalateTier({ tier: "sonnet" }, customTierOrder)).toEqual({ tier: "opus", agent: undefined });
    expect(escalateTier({ tier: "opus" }, customTierOrder)).toBeNull();
  });

  it("returns agent from next tier entry when agent field is set (AC-1)", () => {
    const tierOrder: TierConfig[] = [
      { tier: "fast", agent: "claude", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
    ];
    expect(escalateTier({ tier: "fast" }, tierOrder)).toEqual({ tier: "balanced", agent: "claude" });
  });

  it("returns codex agent when next entry is codex/fast (AC-2)", () => {
    const tierOrder: TierConfig[] = [
      { tier: "fast", agent: "claude", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
      { tier: "fast", agent: "codex", attempts: 2 },
    ];
    expect(escalateTier({ tier: "balanced" }, tierOrder)).toEqual({ tier: "fast", agent: "codex" });
  });

  it("returns null at last entry even with agent field (AC-3)", () => {
    const tierOrder: TierConfig[] = [
      { tier: "fast", agent: "claude", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
    ];
    expect(escalateTier({ tier: "balanced" }, tierOrder)).toBeNull();
  });

  it("returns undefined agent when tierOrder entry has no agent field (AC-4)", () => {
    const tierOrder: TierConfig[] = [
      { tier: "fast", attempts: 5 },
      { tier: "balanced", attempts: 3 },
    ];
    const result = escalateTier({ tier: "fast" }, tierOrder);
    expect(result).toEqual({ tier: "balanced", agent: undefined });
  });

  test("finds next rung by (tier, agent) tuple on a cross-agent ladder", () => {
    const tierOrder: TierConfig[] = [
      { tier: "balanced", agent: "opencode", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
      { tier: "powerful", agent: "claude", attempts: 2 },
    ];
    const result = escalateTier({ tier: "balanced", agent: "opencode" }, tierOrder);
    expect(result).toEqual({ tier: "balanced", agent: "claude" });
  });

  test("escalates opencode@balanced -> claude@balanced -> claude@powerful in sequence", () => {
    const tierOrder: TierConfig[] = [
      { tier: "balanced", agent: "opencode", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
      { tier: "powerful", agent: "claude", attempts: 2 },
    ];
    const step1 = escalateTier({ tier: "balanced", agent: "opencode" }, tierOrder);
    expect(step1).toEqual({ tier: "balanced", agent: "claude" });

    const step2 = escalateTier({ tier: step1!.tier, agent: step1!.agent }, tierOrder);
    expect(step2).toEqual({ tier: "powerful", agent: "claude" });

    const step3 = escalateTier({ tier: step2!.tier, agent: step2!.agent }, tierOrder);
    expect(step3).toBeNull();
  });

  test("does not match the second balanced rung when first is requested", () => {
    const tierOrder: TierConfig[] = [
      { tier: "balanced", agent: "opencode", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
      { tier: "powerful", agent: "claude", attempts: 2 },
    ];
    // Requesting the second balanced rung should escalate to powerful
    const result = escalateTier({ tier: "balanced", agent: "claude" }, tierOrder);
    expect(result).toEqual({ tier: "powerful", agent: "claude" });
  });

  test("returns null when rung not found in ladder", () => {
    const tierOrder: TierConfig[] = [{ tier: "balanced", agent: "claude", attempts: 3 }];
    const result = escalateTier({ tier: "fast", agent: "claude" }, tierOrder);
    expect(result).toBeNull();
  });

  test("returns null when caller has agent set but ladder rungs have no agent (mixed config)", () => {
    // Story has routing.agent = "claude" but tier-only ladder — tuple match finds no rung, escalation blocked.
    // Intentional: user must add agent fields to tierOrder to use cross-agent escalation.
    const tierOrder: TierConfig[] = [
      { tier: "fast", attempts: 3 },
      { tier: "balanced", attempts: 2 },
    ];
    const result = escalateTier({ tier: "fast", agent: "claude" }, tierOrder);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getTierConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("getTierConfig", () => {
  it("returns tier config when tier exists (tier-name-only)", () => {
    const config = getTierConfig({ tier: "balanced" }, defaultTierOrder);
    expect(config).toEqual({ tier: "balanced", attempts: 3 });
  });

  it("returns undefined when tier not found", () => {
    expect(getTierConfig({ tier: "unknown" }, defaultTierOrder)).toBeUndefined();
  });

  it("handles first tier", () => {
    const config = getTierConfig({ tier: "fast" }, defaultTierOrder);
    expect(config).toEqual({ tier: "fast", attempts: 5 });
  });

  it("handles last tier", () => {
    const config = getTierConfig({ tier: "powerful" }, defaultTierOrder);
    expect(config).toEqual({ tier: "powerful", attempts: 2 });
  });

  it("returns undefined for empty tier order", () => {
    expect(getTierConfig({ tier: "fast" }, [])).toBeUndefined();
  });

  it("matches by (tier, agent) tuple on cross-agent ladder", () => {
    const crossAgentOrder: TierConfig[] = [
      { tier: "balanced", agent: "opencode", attempts: 3 },
      { tier: "balanced", agent: "claude", attempts: 2 },
      { tier: "powerful", agent: "claude", attempts: 2 },
    ];
    expect(getTierConfig({ tier: "balanced", agent: "opencode" }, crossAgentOrder)).toEqual({
      tier: "balanced",
      agent: "opencode",
      attempts: 3,
    });
    expect(getTierConfig({ tier: "balanced", agent: "claude" }, crossAgentOrder)).toEqual({
      tier: "balanced",
      agent: "claude",
      attempts: 2,
    });
  });

  it("returns undefined when (tier, agent) tuple not found", () => {
    const crossAgentOrder: TierConfig[] = [{ tier: "balanced", agent: "opencode", attempts: 3 }];
    expect(getTierConfig({ tier: "balanced", agent: "unknown" }, crossAgentOrder)).toBeUndefined();
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
    [
      "large counts (100+200+150=450)",
      [
        { tier: "a", attempts: 100 },
        { tier: "b", attempts: 200 },
        { tier: "c", attempts: 150 },
      ],
      450,
    ],
    [
      "zero attempts (0+5+0=5)",
      [
        { tier: "a", attempts: 0 },
        { tier: "b", attempts: 5 },
        { tier: "c", attempts: 0 },
      ],
      5,
    ],
  ])("sums attempts for %s", (_label, tierOrder, expected) => {
    expect(calculateMaxIterations(tierOrder)).toBe(expected);
  });
});
