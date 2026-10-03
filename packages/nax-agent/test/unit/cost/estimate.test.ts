/**
 * priceCall / estimateCostUsd: tier selection, cache-rate fallback and the
 * rates recorded with each cost. Written for nax-agent in S2-3d: nax's
 * equivalent tests build their rates through nax's config `toPricing`, which
 * does not exist here, so these state `Pricing` directly.
 */

import { describe, expect, test } from "bun:test";
import type { Pricing, TokenUsage } from "@nathapp/nax-ai";
import { estimateCostUsd, priceCall } from "#src/cost/estimate";

const TIERED: Pricing = {
  input: 2,
  output: 12,
  cacheRead: 2,
  cacheWrite: 2,
  tiers: [
    { inputTokensAbove: 200_000, input: 4, output: 18, cacheRead: 4, cacheWrite: 4 },
    { inputTokensAbove: 500_000, input: 8, output: 24, cacheRead: 8, cacheWrite: 8 },
  ],
};

describe("estimateCostUsd", () => {
  test("1M input + 1M output at 2/10 per 1M costs 12", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd(usage, { input: 2, output: 10, cacheRead: 2, cacheWrite: 2 })).toBeCloseTo(12, 6);
  });

  test("cache reads and writes price at their own rates", () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    expect(estimateCostUsd(usage, { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 })).toBeCloseTo(3, 6);
  });

  test("a call with no cache tokens costs only its input and output", () => {
    const usage: TokenUsage = { inputTokens: 500_000, outputTokens: 100_000 };
    expect(estimateCostUsd(usage, { input: 2, output: 10, cacheRead: 99, cacheWrite: 99 })).toBeCloseTo(2, 6);
  });
});

describe("priceCall tier selection", () => {
  test("stays on the base rates when input-class usage does not exceed the first threshold", () => {
    const { costUsd, resolvedRates } = priceCall({ inputTokens: 100_000, outputTokens: 0 }, TIERED);
    expect(resolvedRates.input).toBe(2);
    expect(costUsd).toBeCloseTo(0.2, 6);
  });

  test("a threshold is exclusive: usage exactly at it keeps the lower rates", () => {
    const { resolvedRates } = priceCall({ inputTokens: 200_000, outputTokens: 0 }, TIERED);
    expect(resolvedRates.input).toBe(2);
  });

  test("the tier applies to the whole request, fresh input included", () => {
    const { costUsd, resolvedRates } = priceCall({ inputTokens: 250_000, outputTokens: 0 }, TIERED);
    expect(resolvedRates.input).toBe(4);
    expect(costUsd).toBeCloseTo(1, 6);
  });

  test("the greatest exceeded threshold wins, however the tiers are ordered", () => {
    const reversed: Pricing = { ...TIERED, tiers: [...(TIERED.tiers ?? [])].reverse() };
    const { resolvedRates } = priceCall({ inputTokens: 600_000, outputTokens: 0 }, reversed);
    expect(resolvedRates.input).toBe(8);
    expect(resolvedRates.output).toBe(24);
  });

  test("cache tokens count toward the threshold", () => {
    const { resolvedRates } = priceCall({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 150_000 }, TIERED);
    expect(resolvedRates.input).toBe(4);
  });

  test("the recorded rates are the rates that priced the call", () => {
    const rates: Pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const { resolvedRates } = priceCall({ inputTokens: 1, outputTokens: 1 }, rates);
    expect(resolvedRates).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });
});
