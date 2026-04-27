import { describe, expect, test } from "bun:test";
import {
  COST_RATES,
  estimateCost,
  estimateCostByDuration,
  formatCostWithConfidence,
} from "../../../src/agents/cost";

describe("estimateCost", () => {
  test("calculates cost for fast tier (Haiku)", () => {
    const cost = estimateCost("fast", 1_000_000, 1_000_000);
    // $0.80 input + $4.00 output = $4.80
    expect(cost).toBeCloseTo(4.8, 2);
  });

  test("calculates cost for balanced tier (Sonnet)", () => {
    const cost = estimateCost("balanced", 1_000_000, 1_000_000);
    // $3.00 input + $15.00 output = $18.00
    expect(cost).toBeCloseTo(18.0, 2);
  });

  test("calculates cost for powerful tier (Opus)", () => {
    const cost = estimateCost("powerful", 1_000_000, 1_000_000);
    // $15.00 input + $75.00 output = $90.00
    expect(cost).toBeCloseTo(90.0, 2);
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
  test("estimates cost for 1 minute fast tier with fallback confidence", () => {
    const estimate = estimateCostByDuration("fast", 60000);
    expect(estimate.cost).toBeCloseTo(0.01, 2);
    expect(estimate.confidence).toBe("fallback");
  });

  test("estimates cost for 2 minutes balanced tier with fallback confidence", () => {
    const estimate = estimateCostByDuration("balanced", 120000);
    expect(estimate.cost).toBeCloseTo(0.1, 2);
    expect(estimate.confidence).toBe("fallback");
  });

  test("estimates cost for 30 seconds powerful tier with fallback confidence", () => {
    const estimate = estimateCostByDuration("powerful", 30000);
    expect(estimate.cost).toBeCloseTo(0.075, 3);
    expect(estimate.confidence).toBe("fallback");
  });

  test("handles zero duration with fallback confidence", () => {
    const estimate = estimateCostByDuration("balanced", 0);
    expect(estimate.cost).toBe(0);
    expect(estimate.confidence).toBe("fallback");
  });
});

describe("formatCostWithConfidence", () => {
  test("formats exact confidence without prefix", () => {
    const estimate = { cost: 0.12, confidence: "exact" as const };
    expect(formatCostWithConfidence(estimate)).toBe("$0.12");
  });

  test("formats estimated confidence with tilde prefix", () => {
    const estimate = { cost: 0.15, confidence: "estimated" as const };
    expect(formatCostWithConfidence(estimate)).toBe("~$0.15");
  });

  test("formats fallback confidence with tilde and label", () => {
    const estimate = { cost: 0.05, confidence: "fallback" as const };
    expect(formatCostWithConfidence(estimate)).toBe("~$0.05 (duration-based)");
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
