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

import type { ResolvedRates, TokenUsage } from "@/agents/cost";
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
   * distinction `toNaxTokenUsage` establishes: "no cache data" and "zero cache
   * tokens" must stay distinguishable downstream (nax#2045).
   */
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

export interface TurnAccumulator {
  add(usage: TokenUsage, costUsd: number, rates?: ResolvedRates): void;
  tokens(): TurnTokenTotals;
  costUsd(): number;
  /** Aggregated rate provenance, or undefined when nothing priced. */
  rates(): ResolvedRates | undefined;
}

export function createTurnAccumulator(): TurnAccumulator {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let costUsd = 0;
  const rateTotals = createRateTotals();

  return {
    add(usage, addedCostUsd, rates) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      if (usage.cacheReadInputTokens !== undefined) {
        cacheReadInputTokens = (cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
      }
      if (usage.cacheCreationInputTokens !== undefined) {
        cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
      }
      costUsd += addedCostUsd;
      addRateTotals(rateTotals, usage, rates);
    },

    tokens() {
      return {
        inputTokens,
        outputTokens,
        ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
        ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
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
    // Absent stays absent (never 0): `cacheReadInputTokens` stays
    // `number | undefined` so "no cache data" and "zero cache tokens"
    // remain distinguishable downstream (nax#2045).
    ...cacheUsageFields(usage),
    ...(roundTrip !== undefined ? { roundTrip } : {}),
  };
}
