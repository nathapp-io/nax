import { describe, expect, test } from "bun:test";
import {
  parseTokenUsage,
  estimateCost,
  estimateCostFromOutput,
  estimateCostByDuration,
  COST_RATES,
} from "../src/agents/cost";

describe("parseTokenUsage", () => {
  test("parses Claude Code token output", () => {
    const output = `
Agent completed successfully.
Input tokens: 12345
Output tokens: 6789
Total tokens: 19134
    `;
    const usage = parseTokenUsage(output);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(12345);
    expect(usage?.outputTokens).toBe(6789);
  });

  test("handles case-insensitive matches", () => {
    const output = "INPUT TOKENS: 1000\nOUTPUT TOKENS: 2000";
    const usage = parseTokenUsage(output);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(1000);
    expect(usage?.outputTokens).toBe(2000);
  });

  test("returns null when tokens not found", () => {
    const output = "Agent completed successfully.";
    expect(parseTokenUsage(output)).toBeNull();
  });

  test("returns null when only partial token info", () => {
    const output = "Input tokens: 1000";
    expect(parseTokenUsage(output)).toBeNull();
  });
});

describe("estimateCost", () => {
  test("calculates cost for fast tier (Haiku)", () => {
    const cost = estimateCost("fast", 1_000_000, 1_000_000);
    // $0.80 input + $4.00 output = $4.80
    expect(cost).toBeCloseTo(4.80, 2);
  });

  test("calculates cost for balanced tier (Sonnet)", () => {
    const cost = estimateCost("balanced", 1_000_000, 1_000_000);
    // $3.00 input + $15.00 output = $18.00
    expect(cost).toBeCloseTo(18.00, 2);
  });

  test("calculates cost for powerful tier (Opus)", () => {
    const cost = estimateCost("powerful", 1_000_000, 1_000_000);
    // $15.00 input + $75.00 output = $90.00
    expect(cost).toBeCloseTo(90.00, 2);
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

describe("estimateCostFromOutput", () => {
  test("estimates cost from parsed output", () => {
    const output = "Input tokens: 100000\nOutput tokens: 50000";
    const cost = estimateCostFromOutput("fast", output);
    // (100k/1M * 0.80) + (50k/1M * 4.00) = 0.08 + 0.20 = 0.28
    expect(cost).toBeCloseTo(0.28, 2);
  });

  test("returns 0 when tokens cannot be parsed", () => {
    const output = "Agent completed successfully.";
    const cost = estimateCostFromOutput("balanced", output);
    expect(cost).toBe(0);
  });
});

describe("estimateCostByDuration", () => {
  test("estimates cost for 1 minute fast tier", () => {
    const cost = estimateCostByDuration("fast", 60000);
    expect(cost).toBeCloseTo(0.01, 2);
  });

  test("estimates cost for 2 minutes balanced tier", () => {
    const cost = estimateCostByDuration("balanced", 120000);
    expect(cost).toBeCloseTo(0.10, 2);
  });

  test("estimates cost for 30 seconds powerful tier", () => {
    const cost = estimateCostByDuration("powerful", 30000);
    expect(cost).toBeCloseTo(0.075, 3);
  });

  test("handles zero duration", () => {
    const cost = estimateCostByDuration("balanced", 0);
    expect(cost).toBe(0);
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
