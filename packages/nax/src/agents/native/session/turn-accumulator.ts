/**
 * The six usage/cost/rate counters `runNativeTurn` accumulates.
 *
 * Extracted because the same ten lines appeared three times — after a
 * proactive compaction summary, after a reactive overflow summary, and after
 * each round trip — and a fourth copy was one loop event away. A factory
 * returning an object, matching `createRateTotals` and `createInvalidCallBudget`.
 *
 * `add` and `usageBeat` are deliberately separate: the round-trip beat carries
 * `roundTrip` and the two summary beats do not, so folding the beat into `add`
 * would either drop that field or fabricate it for the summaries.
 */

import type { PricingRates, TokenUsage } from "@/agents/cost";
import { addRateTotals, aggregateRates, createRateTotals } from "./rate-provenance";
import type { NativeTurnActivity } from "./turn-events";
import { cacheUsageFields } from "./turn-types";

/**
 * Token counts ONLY. `costUsd` is deliberately NOT a field here: both readers
 * (`recordNativeTurnFailureUsage` at turn-loop.ts:542 and the TurnResult at
 * :580) take `tokenUsage` and the cost as SEPARATE arguments, so folding cost
 * in would force every call site to destructure it back out.
 */
export interface TurnTokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Undefined until something reports cache data, then a running sum. Staying
   * undefined when nothing ever reports it preserves the absent/zero
   * distinction nax-ai's `toTokenUsage` establishes: "no cache data" and "zero
   * cache tokens" must stay distinguishable downstream (nax#2045).
   */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface TurnAccumulator {
  add(usage: TokenUsage, costUsd: number, rates?: PricingRates): void;
  tokens(): TurnTokenTotals;
  costUsd(): number;
  /** Aggregated rate provenance, or undefined when nothing priced. */
  rates(): PricingRates | undefined;
}

export function createTurnAccumulator(): TurnAccumulator {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let costUsd = 0;
  const rateTotals = createRateTotals();

  return {
    add(usage, addedCostUsd, rates) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      if (usage.cacheReadTokens !== undefined) {
        cacheReadTokens = (cacheReadTokens ?? 0) + usage.cacheReadTokens;
      }
      if (usage.cacheWriteTokens !== undefined) {
        cacheWriteTokens = (cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
      }
      costUsd += addedCostUsd;
      addRateTotals(rateTotals, usage, rates);
    },

    tokens() {
      return {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      };
    },

    costUsd() {
      return costUsd;
    },

    rates() {
      return aggregateRates(rateTotals);
    },
  };
}

/**
 * The `onActivity` usage beat. `roundTrip` is 1-based and omitted for the two
 * compaction-summary beats, which are not round trips.
 */
export function usageBeat(usage: TokenUsage, costUsd: number, roundTrip?: number): NativeTurnActivity {
  return {
    kind: "usage",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd,
    // Absent stays absent (never 0): `cacheReadTokens` stays
    // `number | undefined` so "no cache data" and "zero cache tokens"
    // remain distinguishable downstream (nax#2045).
    ...cacheUsageFields(usage),
    ...(roundTrip !== undefined ? { roundTrip } : {}),
  };
}
