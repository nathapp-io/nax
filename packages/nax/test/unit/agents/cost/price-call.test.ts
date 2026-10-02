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
import type { Pricing, TokenUsage } from "@/agents/cost";
import { estimateCostUsd, priceCall } from "@/agents/cost";
import { toPricing } from "@/config/schema-types";

describe("priceCall — cost math (US-001 AC1, AC8)", () => {
  // AC1: the simplest baseline — 1M input + 1M output at 3/15 -> $18.
  test("[AC1] returns costUsd 18 for 1M input + 1M output at 3/15 per 1M", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const rates: Pricing = toPricing({ inputPer1M: 3, outputPer1M: 15 });
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
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheCreation,
      };
      const rates: Pricing = {
        input: 3,
        output: 15,
        cacheRead: 1,
        cacheWrite: 5,
      };
      const { costUsd, resolvedRates } = priceCall(usage, rates);
      const expected =
        (inputTokens / 1_000_000) * resolvedRates.input +
        (outputTokens / 1_000_000) * resolvedRates.output +
        (cacheRead / 1_000_000) * resolvedRates.cacheRead +
        (cacheCreation / 1_000_000) * resolvedRates.cacheWrite;
      expect(costUsd).toBeCloseTo(expected, 10);
    },
  );
});

describe("priceCall — cache fallback substitution (US-001 AC2, AC3, AC4)", () => {
  // AC2: cacheReadPer1M undefined -> resolvedRates.cacheReadPer1M = inputPer1M.
  test("[AC2] resolvedRates.cacheRead falls back to input when undefined", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: Pricing = toPricing({ inputPer1M: 3, outputPer1M: 15 });
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.cacheRead).toBe(3);
  });

  // AC3: cacheWrite undefined -> resolvedRates.cacheWrite = input.
  test("[AC3] resolvedRates.cacheWrite falls back to input when undefined", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: Pricing = toPricing({ inputPer1M: 3, outputPer1M: 15 });
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.cacheWrite).toBe(3);
  });

  // AC4: when cacheRead IS defined, that value wins — not input.
  test("[AC4] resolvedRates.cacheRead uses the defined value rather than input", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: Pricing = toPricing({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
    });
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.cacheRead).toBe(0.3);
  });

  // Symmetric guard for the cache-creation side: a defined cacheCreationPer1M
  // wins rather than inputPer1M. The story only explicitly pins AC2/AC3/AC4
  // for the read side, but the contract is "defined value beats the fallback"
  // for both fields; pinning the symmetric case keeps the implementation from
  // regressing into a half-fallback.
  test("resolvedRates.cacheWrite uses the defined value rather than input", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: Pricing = toPricing({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheCreationPer1M: 7,
    });
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.cacheWrite).toBe(7);
  });
});

describe("priceCall — tier selection (US-001 AC5, AC6, AC7)", () => {
  // AC5: strictly-greater-than threshold — above the threshold, the tier's
  // inputPer1M wins.
  test("[AC5] applies tier input when input-class usage exceeds the threshold", () => {
    const rates: Pricing = toPricing({
      inputPer1M: 3,
      outputPer1M: 15,
      tiers: [{ inputPer1M: 6, outputPer1M: 30, inputTokensAbove: 100_000 }],
    });
    const usage: TokenUsage = { inputTokens: 150_000, outputTokens: 0 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.input).toBe(6);
  });

  // AC6: on the boundary — exactly the threshold, NOT strictly greater.
  // The base input wins.
  test("[AC6] applies base input when input-class usage equals the threshold (not strictly greater)", () => {
    const rates: Pricing = toPricing({
      inputPer1M: 3,
      outputPer1M: 15,
      tiers: [{ inputPer1M: 6, outputPer1M: 30, inputTokensAbove: 100_000 }],
    });
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 0 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.input).toBe(3);
  });

  // AC7: when multiple tiers both cross, the higher inputTokensAbove wins.
  test("[AC7] picks the tier with the higher inputTokensAbove when both thresholds are crossed", () => {
    const rates: Pricing = toPricing({
      inputPer1M: 3,
      outputPer1M: 15,
      tiers: [
        { inputPer1M: 4, outputPer1M: 20, inputTokensAbove: 50_000 },
        { inputPer1M: 7, outputPer1M: 35, inputTokensAbove: 200_000 },
      ],
    });
    const usage: TokenUsage = { inputTokens: 250_000, outputTokens: 0 };
    const { resolvedRates } = priceCall(usage, rates);
    expect(resolvedRates.input).toBe(7);
    expect(resolvedRates.output).toBe(35);
  });
});

describe("priceCall — undefined cache token counts (US-001 AC10)", () => {
  // AC10: when cacheReadTokens is undefined, costUsd charges nothing
  // for cache reads regardless of whether the rate is configured.
  test("[AC10] costUsd charges nothing for cache reads when cacheReadTokens is undefined", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0 };
    const rates: Pricing = toPricing({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
    });
    const { costUsd } = priceCall(usage, rates);
    // 1M input * $3/M = $3, no cache-read charge. AC10 pins the zero-cache-read
    // leg; the input leg keeps the assertion honest by contributing the
    // expected $3.
    expect(costUsd).toBe(3);
  });

  // Symmetric guard for the cache-creation side. The story names AC10
  // explicitly for the read side; the symmetric case is the natural mirror
  // and pins "undefined operand contributes zero" for both fields.
  test("costUsd charges nothing for cache creation when cacheWriteTokens is undefined", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0 };
    const rates: Pricing = toPricing({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheCreationPer1M: 5,
    });
    const { costUsd } = priceCall(usage, rates);
    expect(costUsd).toBe(3);
  });
});

describe("priceCall — PricingRates shape (US-001)", () => {
  // All four fields are required numbers on PricingRates — distinguishing
  // it from the internal tier-selection shape whose cache fields are
  // optional. Pinning the field shape at runtime.
  test("resolvedRates has all four required numeric fields", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    const rates: Pricing = toPricing({ inputPer1M: 3, outputPer1M: 15 });
    const { resolvedRates } = priceCall(usage, rates);
    expect(typeof resolvedRates.input).toBe("number");
    expect(typeof resolvedRates.output).toBe("number");
    expect(typeof resolvedRates.cacheRead).toBe("number");
    expect(typeof resolvedRates.cacheWrite).toBe("number");
  });
});

describe("estimateCostUsd — wrapper over priceCall (US-001 AC9)", () => {
  // AC9: estimateCostUsd remains a thin wrapper — same inputs return
  // estimateCostUsd(usage, rates) === priceCall(usage, rates).costUsd.
  test("[AC9] estimateCostUsd returns priceCall(usage, rates).costUsd for matching inputs", () => {
    const usage: TokenUsage = {
      inputTokens: 123_456,
      outputTokens: 78_901,
      cacheReadTokens: 12_345,
      cacheWriteTokens: 6_789,
    };
    const rates: Pricing = {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 5,
    };
    expect(estimateCostUsd(usage, rates)).toBe(priceCall(usage, rates).costUsd);
  });

  // AC9 across several configurations — sweeping through tier-selection,
  // fallback, and the boundary case makes sure the wrapper doesn't drift
  // from priceCall in any branch. Each row uses explicit `: TokenUsage` /
  // `: Pricing` annotations on the named fixtures rather than bare
  // `as` casts inside the table — the cast ratchet forbids the loose form.
  const baseUsageNoTiers: TokenUsage = { inputTokens: 500_000, outputTokens: 250_000 };
  const baseRatesNoTiers: Pricing = toPricing({ inputPer1M: 3, outputPer1M: 15 });
  const cacheUsageAll: TokenUsage = {
    inputTokens: 500_000,
    outputTokens: 250_000,
    cacheReadTokens: 100_000,
    cacheWriteTokens: 50_000,
  };
  const cacheRatesAll: Pricing = {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 5,
  };
  const usageAboveTier: TokenUsage = { inputTokens: 250_000, outputTokens: 0 };
  const ratesWithTier: Pricing = toPricing({
    inputPer1M: 3,
    outputPer1M: 15,
    tiers: [{ inputPer1M: 6, outputPer1M: 30, inputTokensAbove: 100_000 }],
  });
  const usageOnTier: TokenUsage = { inputTokens: 100_000, outputTokens: 0 };

  const wrapperCases: ReadonlyArray<readonly [string, TokenUsage, Pricing]> = [
    ["base rates, no tiers", baseUsageNoTiers, baseRatesNoTiers],
    ["cache rates defined, all token classes present", cacheUsageAll, cacheRatesAll],
    ["above tier threshold", usageAboveTier, ratesWithTier],
    ["on tier threshold (base wins, not the tier)", usageOnTier, ratesWithTier],
  ];

  test.each(wrapperCases)("[AC9] %s: estimateCostUsd matches priceCall.costUsd", (_label, usage, rates) => {
    expect(estimateCostUsd(usage, rates)).toBe(priceCall(usage, rates).costUsd);
  });
});

describe("priceCall defensive cache fallback (S1-1)", () => {
  test("a level whose cache rates are missing at runtime prices cache tokens at that level's input rate", () => {
    // A catalog Pricing that, despite its type, arrived without cache rates.
    // JSON.parse keeps the fixture untyped without a double cast.
    const rates: import("@nathapp/nax-agent").Pricing = JSON.parse('{"input":2,"output":8}');
    const { costUsd, resolvedRates } = priceCall(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      rates,
    );
    expect(resolvedRates).toEqual({ input: 2, output: 8, cacheRead: 2, cacheWrite: 2 });
    expect(costUsd).toBe(6);
  });
});
