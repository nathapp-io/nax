import type { PricingRates, TokenUsage } from "@/agents/cost/standard-types";

interface RateTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  cacheReadCostPerMillionTokens: number;
  cacheCreationCostPerMillionTokens: number;
  latestRates?: PricingRates;
  complete: boolean;
}

export function createRateTotals(): RateTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputCostPerMillionTokens: 0,
    outputCostPerMillionTokens: 0,
    cacheReadCostPerMillionTokens: 0,
    cacheCreationCostPerMillionTokens: 0,
    complete: true,
  };
}

export function addRateTotals(totals: RateTotals, usage: TokenUsage, rates: PricingRates | undefined): void {
  if (rates === undefined) {
    totals.complete = false;
    return;
  }
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
  totals.cacheCreationTokens += usage.cacheWriteTokens ?? 0;
  totals.inputCostPerMillionTokens += usage.inputTokens * rates.input;
  totals.outputCostPerMillionTokens += usage.outputTokens * rates.output;
  totals.cacheReadCostPerMillionTokens += (usage.cacheReadTokens ?? 0) * rates.cacheRead;
  totals.cacheCreationCostPerMillionTokens += (usage.cacheWriteTokens ?? 0) * rates.cacheWrite;
  totals.latestRates = rates;
}

export function aggregateRates(totals: RateTotals): PricingRates | undefined {
  if (!totals.complete || totals.latestRates === undefined) return undefined;
  const weightedRate = (tokens: number, rateTotal: number, fallback: number) =>
    tokens === 0 ? fallback : rateTotal / tokens;
  return {
    input: weightedRate(totals.inputTokens, totals.inputCostPerMillionTokens, totals.latestRates.input),
    output: weightedRate(totals.outputTokens, totals.outputCostPerMillionTokens, totals.latestRates.output),
    cacheRead: weightedRate(totals.cacheReadTokens, totals.cacheReadCostPerMillionTokens, totals.latestRates.cacheRead),
    cacheWrite: weightedRate(
      totals.cacheCreationTokens,
      totals.cacheCreationCostPerMillionTokens,
      totals.latestRates.cacheWrite,
    ),
  };
}
