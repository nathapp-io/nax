/**
 * US-001 / Pricing returns effective rates — `priceCall` exposes the effective
 * per-1M rates used to price a request so downstream cost rows can carry the
 * numbers whose arithmetic reproduces the recorded cost.
 *
 * `estimateCostUsd` is a thin wrapper over `priceCall` and remains a stable
 * contract for every existing caller; the new shape lives in `priceCall`'s
 * return value.
 */

import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "@/agents/cost";
import { estimateCostUsd, priceCall } from "@/agents/cost";
import type { TokenPricing, TokenPricingTier } from "@/config/schema-types";

describe("priceCall — cost math (US-001 AC1, AC8)", () => {
  // AC1: the simplest baseline — 1M input + 1M output at 3/15 -> $18.
  test("[AC1] returns costUsd 18 for 1M input + 1M output at 3/15 per 1M", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const rates: TokenPricing = { inputPer1M: 3, outputPer1M: 15 };
    const { costUsd } = priceCall(usage, rates);
    expect(costUsd).toBe(18);
  });

  // AC8: identity — summing each token class / 1M * matching resolvedRates
  // field equals returned costUsd. This is the property the story names as
  // what makes a row's arithmetic verifiable. We sweep across several
  // configurations that all use the same rule.
  test.each([
    [0, 0, 0, 0],
    [1_000_000, 0, 0, 0],
    [0, 1_000_000, 0, 0],
    [1_000_000, 1_000_000, 0, 0],
    [500_000, 250_000, 100_000, 50_000],
  ])(
    "[AC8] costUsd = sum of (tokens/1M * matching resolvedRates field) — usage %p",
    (inputTokens, outputTokens, cacheRead, cacheCreation) => {
      const usage: TokenUsage = {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
      };
      const rates: TokenPricing = {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheReadPer1M: 1,
        cacheCreationPer1M: 5,
      };
      const { costUsd, resolvedRates } = priceCall(usage, rates);
      const expected =
        (inputTokens / 1_000_000) * resolvedRates.inputPer1M +
        (outputTokens / 1_000_000) * resolvedRates.outputPer1M +
        (cacheRead / 1_000_000) * resolvedRates.cacheReadPer1M +
        (cacheCreation / 1_000_000) * resolvedRates.cacheCreationPer1M;
      expect(costUsd).toBeCloseTo(expected, 10);
    },
  );
});

describe("priceCall — cache fallback substitution (US-001 AC2, AC3, AC4)", () => {
  // AC2: cacheReadPer1M undefined -> resolvedRates.cacheReadPer1M = inputPer1M.
  test("[AC2] resolvedRates.cacheReadPer1M falls back to inputPer1M when undefined", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: TokenPricing = { inputPer1M: 3, outputPer1M: 15 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.cacheReadPer1M).toBe(3);
  });

  // AC3: cacheCreationPer1M undefined -> resolvedRates.cacheCreationPer1M = inputPer1M.
  test("[AC3] resolvedRates.cacheCreationPer1M falls back to inputPer1M when undefined", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: TokenPricing = { inputPer1M: 3, outputPer1M: 15 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.cacheCreationPer1M).toBe(3);
  });

  // AC4: when cacheReadPer1M IS defined, that value wins — not inputPer1M.
  test("[AC4] resolvedRates.cacheReadPer1M uses the defined value rather than inputPer1M", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: TokenPricing = {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
    };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.cacheReadPer1M).toBe(0.3);
  });

  // Symmetric guard for the cache-creation side: a defined cacheCreationPer1M
  // wins rather than inputPer1M. The story only explicitly pins AC2/AC3/AC4
  // for the read side, but the contract is "defined value beats the fallback"
  // for both fields; pinning the symmetric case keeps the implementation from
  // regressing into a half-fallback.
  test("resolvedRates.cacheCreationPer1M uses the defined value rather than inputPer1M", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: TokenPricing = {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheCreationPer1M: 7,
    };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.cacheCreationPer1M).toBe(7);
  });
});

describe("priceCall — tier selection (US-001 AC5, AC6, AC7)", () => {
  // AC5: strictly-greater-than threshold — above the threshold, the tier's
  // inputPer1M wins.
  test("[AC5] applies tier inputPer1M when input-class usage exceeds the threshold", () => {
    const tier: TokenPricingTier = {
      inputPer1M: 6,
      outputPer1M: 30,
      inputTokensAbove: 100_000,
    };
    const rates: TokenPricing = {
      inputPer1M: 3,
      outputPer1M: 15,
      tiers: [tier],
    };
    const usage: TokenUsage = { inputTokens: 150_000, outputTokens: 0 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.inputPer1M).toBe(6);
  });

  // AC6: on the boundary — exactly the threshold, NOT strictly greater.
  // The base inputPer1M wins.
  test("[AC6] applies base inputPer1M when input-class usage equals the threshold (not strictly greater)", () => {
    const tier: TokenPricingTier = {
      inputPer1M: 6,
      outputPer1M: 30,
      inputTokensAbove: 100_000,
    };
    const rates: TokenPricing = {
      inputPer1M: 3,
      outputPer1M: 15,
      tiers: [tier],
    };
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 0 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.inputPer1M).toBe(3);
  });

  // AC7: when multiple tiers both cross, the higher inputTokensAbove wins.
  test("[AC7] picks the tier with the higher inputTokensAbove when both thresholds are crossed", () => {
    const lower: TokenPricingTier = {
      inputPer1M: 4,
      outputPer1M: 20,
      inputTokensAbove: 50_000,
    };
    const higher: TokenPricingTier = {
      inputPer1M: 7,
      outputPer1M: 35,
      inputTokensAbove: 200_000,
    };
    const rates: TokenPricing = {
      inputPer1M: 3,
      outputPer1M: 15,
      tiers: [lower, higher],
    };
    const usage: TokenUsage = { inputTokens: 250_000, outputTokens: 0 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.inputPer1M).toBe(7);
    expect(resolvedRates.outputPer1M).toBe(35);
  });
});

describe("priceCall — undefined cache token counts (US-001 AC10)", () => {
  // AC10: when cacheReadInputTokens is undefined, costUsd charges nothing
  // for cache reads regardless of whether the rate is configured.
  test("[AC10] costUsd charges nothing for cache reads when cacheReadInputTokens is undefined", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0 };
    const rates: TokenPricing = {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
    };
    const { costUsd } = priceCall(usage, rates);
    // 1M input * $3/M = $3, no cache-read charge. AC10 pins the zero-cache-read
    // leg; the input leg keeps the assertion honest by contributing the
    // expected $3.
    expect(costUsd).toBe(3);
  });

  // Symmetric guard for the cache-creation side. The story names AC10
  // explicitly for the read side; the symmetric case is the natural mirror
  // and pins "undefined operand contributes zero" for both fields.
  test("costUsd charges nothing for cache creation when cacheCreationInputTokens is undefined", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0 };
    const rates: TokenPricing = {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheCreationPer1M: 5,
    };
    const { costUsd } = priceCall(usage, rates);
    expect(costUsd).toBe(3);
  });
});

describe("priceCall — ResolvedRates shape (US-001)", () => {
  // All four fields are required numbers on ResolvedRates — distinguishing
  // it from the internal tier-selection shape whose cache fields are
  // optional. Pinning the field shape at runtime.
  test("resolvedRates has all four required numeric fields", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: TokenPricing = { inputPer1M: 3, outputPer1M: 15 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(typeof resolvedRates.inputPer1M).toBe("number");
    expect(typeof resolvedRates.outputPer1M).toBe("number");
    expect(typeof resolvedRates.cacheReadPer1M).toBe("number");
    expect(typeof resolvedRates.cacheCreationPer1M).toBe("number");
  });
});

describe("estimateCostUsd — wrapper over priceCall (US-001 AC9)", () => {
  // AC9: estimateCostUsd remains a thin wrapper — same inputs return
  // estimateCostUsd(usage, rates) === priceCall(usage, rates).costUsd.
  test("[AC9] estimateCostUsd returns priceCall(usage, rates).costUsd for matching inputs", () => {
    const usage: TokenUsage = {
      inputTokens: 123_456,
      outputTokens: 78_901,
      cacheReadInputTokens: 12_345,
      cacheCreationInputTokens: 6_789,
    };
    const rates: TokenPricing = {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
      cacheCreationPer1M: 5,
    };
    expect(estimateCostUsd(usage, rates)).toBe(priceCall(usage, rates).costUsd);
  });

  // AC9 across several configurations — sweeping through tier-selection,
  // fallback, and the boundary case makes sure the wrapper doesn't drift
  // from priceCall in any branch. Each row uses explicit `: TokenUsage` /
  // `: TokenPricing` annotations on the named fixtures rather than bare
  // `as` casts inside the table — the cast ratchet forbids the loose form.
  const baseUsageNoTiers: TokenUsage = { inputTokens: 500_000, outputTokens: 250_000 };
  const baseRatesNoTiers: TokenPricing = { inputPer1M: 3, outputPer1M: 15 };
  const cacheUsageAll: TokenUsage = {
    inputTokens: 500_000,
    outputTokens: 250_000,
    cacheReadInputTokens: 100_000,
    cacheCreationInputTokens: 50_000,
  };
  const cacheRatesAll: TokenPricing = {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheCreationPer1M: 5,
  };
  const usageAboveTier: TokenUsage = { inputTokens: 250_000, outputTokens: 0 };
  const ratesWithTier: TokenPricing = {
    inputPer1M: 3,
    outputPer1M: 15,
    tiers: [{ inputPer1M: 6, outputPer1M: 30, inputTokensAbove: 100_000 }],
  };
  const usageOnTier: TokenUsage = { inputTokens: 100_000, outputTokens: 0 };

  const wrapperCases: ReadonlyArray<readonly [string, TokenUsage, TokenPricing]> = [
    ["base rates, no tiers", baseUsageNoTiers, baseRatesNoTiers],
    ["cache rates defined, all token classes present", cacheUsageAll, cacheRatesAll],
    ["above tier threshold", usageAboveTier, ratesWithTier],
    ["on tier threshold (base wins, not the tier)", usageOnTier, ratesWithTier],
  ];

  test.each(wrapperCases)("[AC9] %s: estimateCostUsd matches priceCall.costUsd", (_label, usage, rates) => {
    expect(estimateCostUsd(usage, rates)).toBe(priceCall(usage, rates).costUsd);
  });
});
