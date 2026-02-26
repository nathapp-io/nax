import { describe, expect, test } from "bun:test";
import {
  parseTokenUsage,
  estimateCost,
  estimateCostFromOutput,
  estimateCostByDuration,
  formatCostWithConfidence,
  COST_RATES,
} from "../../src/agents/cost";

describe("parseTokenUsage", () => {
  test("parses Claude Code token output with estimated confidence", () => {
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
    expect(usage?.confidence).toBe('estimated');
  });

  test("handles case-insensitive matches with estimated confidence", () => {
    const output = "INPUT TOKENS: 1000\nOUTPUT TOKENS: 2000";
    const usage = parseTokenUsage(output);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(1000);
    expect(usage?.outputTokens).toBe(2000);
    expect(usage?.confidence).toBe('estimated');
  });

  test("returns null when tokens not found", () => {
    const output = "Agent completed successfully.";
    expect(parseTokenUsage(output)).toBeNull();
  });

  test("returns null when only partial token info", () => {
    const output = "Input tokens: 1000";
    expect(parseTokenUsage(output)).toBeNull();
  });

  test("parses JSON-structured token report with exact confidence (BUG-3)", () => {
    const output = `{"usage": {"input_tokens": 15000, "output_tokens": 8500}}`;
    const usage = parseTokenUsage(output);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(15000);
    expect(usage?.outputTokens).toBe(8500);
    expect(usage?.confidence).toBe('exact');
  });

  test("parses JSON with surrounding text with exact confidence (BUG-3)", () => {
    const output = `
Agent completed.
{"usage": {"input_tokens": 12000, "output_tokens": 4000}}
Done.
    `;
    const usage = parseTokenUsage(output);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(12000);
    expect(usage?.outputTokens).toBe(4000);
    expect(usage?.confidence).toBe('exact');
  });

  test("parses underscore format with estimated confidence (BUG-3)", () => {
    const output = "input_tokens: 9000\noutput_tokens: 3000";
    const usage = parseTokenUsage(output);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(9000);
    expect(usage?.outputTokens).toBe(3000);
    expect(usage?.confidence).toBe('estimated');
  });

  test("rejects unreasonably large token counts (BUG-3 sanity check)", () => {
    const output = "Input tokens: 5000000\nOutput tokens: 2000000";
    // Should reject tokens > 1M as likely false positive
    expect(parseTokenUsage(output)).toBeNull();
  });

  test("requires at least 2 digits to avoid false positives (BUG-3)", () => {
    const output = "version: 1\ninput: 5\noutput: 8";
    // Should not match single-digit numbers
    expect(parseTokenUsage(output)).toBeNull();
  });

  test("handles mixed format with word boundaries and estimated confidence (BUG-3)", () => {
    const output = `
Model: claude-sonnet-4-5
input tokens: 15432
output tokens: 7891
Status: success
    `;
    const usage = parseTokenUsage(output);
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(15432);
    expect(usage?.outputTokens).toBe(7891);
    expect(usage?.confidence).toBe('estimated');
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
  test("estimates cost from parsed output with confidence", () => {
    const output = "Input tokens: 100000\nOutput tokens: 50000";
    const estimate = estimateCostFromOutput("fast", output);
    // (100k/1M * 0.80) + (50k/1M * 4.00) = 0.08 + 0.20 = 0.28
    expect(estimate).not.toBeNull();
    expect(estimate?.cost).toBeCloseTo(0.28, 2);
    expect(estimate?.confidence).toBe('estimated');
  });

  test("returns exact confidence for JSON output", () => {
    const output = '{"usage": {"input_tokens": 100000, "output_tokens": 50000}}';
    const estimate = estimateCostFromOutput("fast", output);
    expect(estimate).not.toBeNull();
    expect(estimate?.cost).toBeCloseTo(0.28, 2);
    expect(estimate?.confidence).toBe('exact');
  });

  test("returns null when tokens cannot be parsed", () => {
    const output = "Agent completed successfully.";
    const estimate = estimateCostFromOutput("balanced", output);
    expect(estimate).toBeNull();
  });
});

describe("estimateCostByDuration", () => {
  test("estimates cost for 1 minute fast tier with fallback confidence", () => {
    const estimate = estimateCostByDuration("fast", 60000);
    expect(estimate.cost).toBeCloseTo(0.01, 2);
    expect(estimate.confidence).toBe('fallback');
  });

  test("estimates cost for 2 minutes balanced tier with fallback confidence", () => {
    const estimate = estimateCostByDuration("balanced", 120000);
    expect(estimate.cost).toBeCloseTo(0.10, 2);
    expect(estimate.confidence).toBe('fallback');
  });

  test("estimates cost for 30 seconds powerful tier with fallback confidence", () => {
    const estimate = estimateCostByDuration("powerful", 30000);
    expect(estimate.cost).toBeCloseTo(0.075, 3);
    expect(estimate.confidence).toBe('fallback');
  });

  test("handles zero duration with fallback confidence", () => {
    const estimate = estimateCostByDuration("balanced", 0);
    expect(estimate.cost).toBe(0);
    expect(estimate.confidence).toBe('fallback');
  });
});

describe("formatCostWithConfidence", () => {
  test("formats exact confidence without prefix", () => {
    const estimate = { cost: 0.12, confidence: 'exact' as const };
    expect(formatCostWithConfidence(estimate)).toBe("$0.12");
  });

  test("formats estimated confidence with tilde prefix", () => {
    const estimate = { cost: 0.15, confidence: 'estimated' as const };
    expect(formatCostWithConfidence(estimate)).toBe("~$0.15");
  });

  test("formats fallback confidence with tilde and label", () => {
    const estimate = { cost: 0.05, confidence: 'fallback' as const };
    expect(formatCostWithConfidence(estimate)).toBe("~$0.05 (duration-based)");
  });

  test("formats very small costs correctly", () => {
    const estimate = { cost: 0.001, confidence: 'exact' as const };
    expect(formatCostWithConfidence(estimate)).toBe("$0.00");
  });

  test("formats large costs correctly", () => {
    const estimate = { cost: 12.345, confidence: 'estimated' as const };
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
