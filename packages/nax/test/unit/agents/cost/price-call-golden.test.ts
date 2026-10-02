/**
 * S1-1 golden equivalence (S1 spec section 8): config pricing converted with
 * toPricing, then priced with the standard-vocabulary priceCall, must equal the
 * pre-S1-1 priceCall on the same inputs. Expected values were captured from the
 * old implementation at main fff826752.
 */
import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "@nathapp/nax-agent";
import { priceCall } from "@/agents/cost";
import { type ConfigPricing, toPricing } from "@/config/schema-types";

interface GoldenCase {
  readonly name: string;
  readonly config: ConfigPricing;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly resolved: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const TIERED: ConfigPricing = {
  inputPer1M: 1.25,
  outputPer1M: 10,
  cacheReadPer1M: 0.125,
  cacheCreationPer1M: 1.5625,
  tiers: [
    { inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25, cacheCreationPer1M: 3.125, inputTokensAbove: 200_000 },
  ],
};
const WITH_CACHE: ConfigPricing = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheCreationPer1M: 3.75 };

const CASES: readonly GoldenCase[] = [
  {
    name: "flat-no-cache-rates",
    config: { inputPer1M: 3, outputPer1M: 15 },
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 },
    costUsd: 0.016800000000000002,
    resolved: { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 },
  },
  {
    name: "flat-with-cache-rates",
    config: WITH_CACHE,
    usage: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 5_000_000, cacheWriteTokens: 400_000 },
    costUsd: 9,
    resolved: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    name: "tier-above",
    config: TIERED,
    usage: { inputTokens: 150_000, outputTokens: 1000, cacheReadTokens: 60_000, cacheWriteTokens: 0 },
    costUsd: 0.405,
    resolved: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
  },
  {
    name: "tier-below",
    config: TIERED,
    usage: { inputTokens: 100_000, outputTokens: 1000 },
    costUsd: 0.135,
    resolved: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
  },
  {
    name: "tier-missing-cache-rates",
    config: {
      inputPer1M: 2,
      outputPer1M: 8,
      cacheReadPer1M: 0.5,
      tiers: [{ inputPer1M: 4, outputPer1M: 16, inputTokensAbove: 100_000 }],
    },
    usage: { inputTokens: 90_000, outputTokens: 10, cacheReadTokens: 20_000, cacheWriteTokens: 5000 },
    costUsd: 0.46016,
    resolved: { input: 4, output: 16, cacheRead: 4, cacheWrite: 4 },
  },
  {
    name: "absent-cache-counts",
    config: WITH_CACHE,
    usage: { inputTokens: 10, outputTokens: 10 },
    costUsd: 0.00018,
    resolved: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    name: "zero-cache-counts",
    config: WITH_CACHE,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.00018,
    resolved: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
];

describe("priceCall golden equivalence with pre-S1-1 math", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { costUsd, resolvedRates } = priceCall(c.usage, toPricing(c.config));
      expect(costUsd).toBe(c.costUsd);
      expect(resolvedRates).toEqual(c.resolved);
    });
  }
});

describe("toPricing", () => {
  test("fills each level's missing cache rates from that level's own input rate", () => {
    expect(
      toPricing({
        inputPer1M: 2,
        outputPer1M: 8,
        cacheReadPer1M: 0.5,
        tiers: [{ inputPer1M: 4, outputPer1M: 16, inputTokensAbove: 100_000 }],
      }),
    ).toEqual({
      input: 2,
      output: 8,
      cacheRead: 0.5,
      cacheWrite: 2,
      tiers: [{ input: 4, output: 16, cacheRead: 4, cacheWrite: 4, inputTokensAbove: 100_000 }],
    });
  });

  test("omits tiers when the config has none", () => {
    expect(toPricing({ inputPer1M: 3, outputPer1M: 15 })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 3,
      cacheWrite: 3,
    });
  });
});
