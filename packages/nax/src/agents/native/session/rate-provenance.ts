import type { ResolvedRates, TokenUsage } from "@/agents/cost";

interface RateTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  cacheReadCostPerMillionTokens: number;
  cacheCreationCostPerMillionTokens: number;
  latestRates?: ResolvedRates;
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

export function addRateTotals(totals: RateTotals, usage: TokenUsage, rates: ResolvedRates | undefined): void {
  if (rates === undefined) {
    totals.complete = false;
    return;
  }
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
  totals.cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
  totals.inputCostPerMillionTokens += usage.inputTokens * rates.inputPer1M;
  totals.outputCostPerMillionTokens += usage.outputTokens * rates.outputPer1M;
  totals.cacheReadCostPerMillionTokens += (usage.cacheReadInputTokens ?? 0) * rates.cacheReadPer1M;
  totals.cacheCreationCostPerMillionTokens += (usage.cacheCreationInputTokens ?? 0) * rates.cacheCreationPer1M;
  totals.latestRates = rates;
}

export function aggregateRates(totals: RateTotals): ResolvedRates | undefined {
  if (!totals.complete || totals.latestRates === undefined) return undefined;
  const weightedRate = (tokens: number, rateTotal: number, fallback: number) =>
    tokens === 0 ? fallback : rateTotal / tokens;
  return {
    inputPer1M: weightedRate(totals.inputTokens, totals.inputCostPerMillionTokens, totals.latestRates.inputPer1M),
    outputPer1M: weightedRate(totals.outputTokens, totals.outputCostPerMillionTokens, totals.latestRates.outputPer1M),
    cacheReadPer1M: weightedRate(
      totals.cacheReadTokens,
      totals.cacheReadCostPerMillionTokens,
      totals.latestRates.cacheReadPer1M,
    ),
    cacheCreationPer1M: weightedRate(
      totals.cacheCreationTokens,
      totals.cacheCreationCostPerMillionTokens,
      totals.latestRates.cacheCreationPer1M,
    ),
  };
}
