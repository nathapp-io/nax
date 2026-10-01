/**
 * AC16-AC19: `estimateCostUsd` relocated to `src/agents/cost/` so the ACP and
 * native paths share one tier-aware, cache-aware estimator. Re-exported from
 * `@/agents/cost`.
 *
 * AC16 (1M input + 1M output at 2/10 -> $12) is the unit-of-truth: the
 * relocated function must reproduce the previous behaviour exactly, since
 * tests already exist in `test/unit/agents/native/models.test.ts` for the
 * exhaustive case.
 */

import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "@/agents/cost";
import { estimateCostUsd } from "@/agents/cost";
import type { TokenPricing, TokenPricingTier } from "@/config/schema-types";

describe("estimateCostUsd (relocated to @/agents/cost)", () => {
  // AC16: success path — the simplest baseline.
  test("AC16: 1M input + 1M output at 2/10 per 1M returns 12", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const rates: TokenPricing = { inputPer1M: 2, outputPer1M: 10 };
    expect(estimateCostUsd(usage, rates)).toBeCloseTo(12, 6);
  });

  // AC17: success path — cache-read tokens price at inputPer1M when no
  // dedicated cache rate is configured (the old fallback kept for every rate
  // card that has not been extended with cache rates).
  test("AC17: 1M cache-read tokens price at inputPer1M when cacheReadPer1M is unset", () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    };
    const rates: TokenPricing = { inputPer1M: 2, outputPer1M: 10 };
    // 1M cache-read * $2 = $2
    expect(estimateCostUsd(usage, rates)).toBeCloseTo(2, 6);
  });

  // AC18: success path — above the threshold, the tier's inputPer1M wins
  // even for fresh input tokens.
  test("AC18: applies the tier inputPer1M when input-class usage exceeds the threshold", () => {
    const tier: TokenPricingTier = {
      inputPer1M: 4,
      outputPer1M: 18,
      inputTokensAbove: 200_000,
    };
    const rates: TokenPricing = {
      inputPer1M: 2,
      outputPer1M: 12,
      tiers: [tier],
    };
    // 250_000 input-class tokens strictly exceeds 200_000, so the tier wins
    // for the WHOLE request — even the fresh 250_000 input tokens.
    const usage: TokenUsage = { inputTokens: 250_000, outputTokens: 0 };
    expect(estimateCostUsd(usage, rates)).toBeCloseTo((250_000 / 1_000_000) * 4, 6);
  });

  // AC19: boundary path — below the threshold, the base inputPer1M wins.
  test("AC19: applies the base inputPer1M when input-class usage does not exceed the threshold", () => {
    const rates: TokenPricing = {
      inputPer1M: 2,
      outputPer1M: 12,
      tiers: [
        {
          inputPer1M: 4,
          outputPer1M: 18,
          inputTokensAbove: 200_000,
        },
      ],
    };
    // 100_000 input tokens < 200_000 threshold, so the base rate wins.
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 0 };
    expect(estimateCostUsd(usage, rates)).toBeCloseTo((100_000 / 1_000_000) * 2, 6);
  });
});
