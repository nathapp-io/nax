/**
 * Tests for cost/calculate.ts — addTokenUsage (Issue 708 Phase A)
 *
 * Covers:
 * - Basic addition of input/output tokens
 * - Addition when one side has undefined cache fields
 * - Addition when both sides have cache fields
 * - Zero preservation behavior (optional fields stay omitted when both undefined)
 * - Defined zero values are preserved in output
 */

import { describe, expect, test } from "bun:test";
import { addTokenUsage, estimateCostFromTokenUsage, resolvePricingSource } from "../../../../src/agents/cost";
import type { TokenUsage } from "../../../../src/agents/cost";

describe("addTokenUsage", () => {
  test("adds input and output tokens", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(125);
  });

  test("omits cache fields when both operands have them undefined", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBeUndefined();
    expect(result.cacheCreationInputTokens).toBeUndefined();
  });

  test("includes cache fields when one operand has them defined", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBe(10);
    expect(result.cacheCreationInputTokens).toBeUndefined();
  });

  test("sums cache fields when both operands have them defined", () => {
    const a: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    };
    const b: TokenUsage = {
      inputTokens: 200,
      outputTokens: 75,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 15,
    };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBe(30);
    expect(result.cacheCreationInputTokens).toBe(20);
  });

  test("preserves defined zero values in output", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBe(0);
  });

  test("returns zero totals when both operands are zero", () => {
    const a: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const b: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const result = addTokenUsage(a, b);

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheReadInputTokens).toBeUndefined();
    expect(result.cacheCreationInputTokens).toBeUndefined();
  });
});

// ─── resolvePricingSource (#1433) ────────────────────────────────────────────

describe("resolvePricingSource", () => {
  test.each([
    ["haiku", "model-rates"],
    ["sonnet", "model-rates"],
    ["claude-haiku-4-5", "model-rates"],
    // Real July models with no MODEL_PRICING entry.
    ["minimax/MiniMax-M2.7", "fallback-rates"],
    ["gpt-5.6-luna[medium]", "fallback-rates"],
  ])("%s resolves to %s", (model, expected) => {
    expect(resolvePricingSource(model)).toBe(expected);
  });

  test.each([[undefined], [""], ["unknown"]])("%p resolves to unknown-model", (model) => {
    expect(resolvePricingSource(model as string | undefined)).toBe("unknown-model");
  });

  test("agrees with the estimator about which models use the generic card", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // The generic card is $3/$15 per 1M. A model reported as fallback-rates must
    // price exactly there; one reported as model-rates must not (haiku is $0.8/$4).
    expect(resolvePricingSource("minimax/MiniMax-M2.7")).toBe("fallback-rates");
    expect(estimateCostFromTokenUsage(usage, "minimax/MiniMax-M2.7")).toBeCloseTo(18, 5);

    expect(resolvePricingSource("haiku")).toBe("model-rates");
    expect(estimateCostFromTokenUsage(usage, "haiku")).toBeCloseTo(4.8, 5);
  });
});
