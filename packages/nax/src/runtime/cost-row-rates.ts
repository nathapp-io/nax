/**
 * Rates as persisted on a cost row (schema 8). The keys predate the S1-1
 * vocabulary change and stay as they are; `toCostRowRates` maps the standard
 * `PricingRates` onto them, in their historical key order.
 */
import type { PricingRates } from "@/agents/cost";

export interface CostRowRates {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly cacheReadPer1M: number;
  readonly cacheCreationPer1M: number;
}

export function toCostRowRates(rates: PricingRates): CostRowRates {
  return {
    inputPer1M: rates.input,
    outputPer1M: rates.output,
    cacheReadPer1M: rates.cacheRead,
    cacheCreationPer1M: rates.cacheWrite,
  };
}
