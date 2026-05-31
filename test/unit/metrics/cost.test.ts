import { describe, expect, test } from "bun:test";
import {
  COST_RATES,
  estimateCost,
  estimateCostByDuration,
  formatCostWithConfidence,
} from "../../../src/agents/cost";

describe("estimateCost", () => {
  test.each([
    ["fast (Haiku)", "fast" as const, 4.8],
    ["balanced (Sonnet)", "balanced" as const, 18.0],
    ["powerful (Opus)", "powerful" as const, 90.0],
  ])("calculates cost for %s tier", (_label, tier, expected) => {
    const cost = estimateCost(tier, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(expected, 2);
  });

  test("handles small token counts", () => {
    const cost = estimateCost("fast", 10_000, 5_000);
    // (10k/1M * 0.80) + (5k/1M * 4.00) = 0.008 + 0.020 = 0.028
    expect(cost).toBeCloseTo(0.028, 3);
  });

  test("handles zero tokens", () => {
    const cost = estimateCost("balanced", 0, 0);
    expect(cost).toBe(0);
  });
});

describe("estimateCostByDuration", () => {
  test.each([
    ["1 minute fast", "fast" as const, 60000, 0.01, 2],
    ["2 minutes balanced", "balanced" as const, 120000, 0.1, 2],
    ["30 seconds powerful", "powerful" as const, 30000, 0.075, 3],
  ])("estimates cost for %s tier with fallback confidence", (_label, tier, durationMs, expectedCost, precision) => {
    const estimate = estimateCostByDuration(tier, durationMs);
    expect(estimate.cost).toBeCloseTo(expectedCost, precision);
    expect(estimate.confidence).toBe("fallback");
  });

  test("handles zero duration with fallback confidence", () => {
    const estimate = estimateCostByDuration("balanced", 0);
    expect(estimate.cost).toBe(0);
    expect(estimate.confidence).toBe("fallback");
  });
});

describe("formatCostWithConfidence", () => {
  test.each([
    ["exact confidence without prefix", { cost: 0.12, confidence: "exact" as const }, "$0.12"],
    ["estimated confidence with tilde prefix", { cost: 0.15, confidence: "estimated" as const }, "~$0.15"],
    ["fallback confidence with tilde and label", { cost: 0.05, confidence: "fallback" as const }, "~$0.05 (duration-based)"],
  ])("formats %s", (_label, estimate, expected) => {
    expect(formatCostWithConfidence(estimate)).toBe(expected);
  });

  test("formats very small costs correctly", () => {
    const estimate = { cost: 0.001, confidence: "exact" as const };
    expect(formatCostWithConfidence(estimate)).toBe("$0.00");
  });

  test("formats large costs correctly", () => {
    const estimate = { cost: 12.345, confidence: "estimated" as const };
    expect(formatCostWithConfidence(estimate)).toBe("~$12.35");
  });
});

describe("COST_RATES", () => {
  test("has rates for all model tiers", () => {
    expect(COST_RATES.fast).toBeDefined();
    expect(COST_RATES.balanced).toBeDefined();
    expect(COST_RATES.powerful).toBeDefined();
  });

  test("rates are positive numbers", () => {
    for (const tier of ["fast", "balanced", "powerful"] as const) {
      expect(COST_RATES[tier].inputPer1M).toBeGreaterThan(0);
      expect(COST_RATES[tier].outputPer1M).toBeGreaterThan(0);
    }
  });

  test("output costs are higher than input costs", () => {
    for (const tier of ["fast", "balanced", "powerful"] as const) {
      expect(COST_RATES[tier].outputPer1M).toBeGreaterThan(COST_RATES[tier].inputPer1M);
    }
  });
});
