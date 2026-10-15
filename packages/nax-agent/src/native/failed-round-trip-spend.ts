/**
 * Prices the tokens a failed or aborted round trip was billed for and attaches
 * them to the thrown error (`session/partial-spend.ts`), where the turn loop's
 * `completeWithRecovery` folds them into the turn's accumulated usage.
 *
 * nax-ai's `collectStream` hands the partial usage over on the error
 * (`partialUsageOf`); only the adapter holds the rate card, so pricing happens
 * here, once, with the same `priceCall` the success path uses.
 */

import { partialUsageOf } from "@nathapp/nax-ai";
import { priceCall } from "#src/cost/core/index";
import type { Pricing } from "#src/cost/standard-types";
import { attachPartialSpend } from "./session/partial-spend.ts";

function recordFailedRoundTripSpend(err: unknown, rates: Pricing): void {
  const usage = partialUsageOf(err);
  if (usage === undefined) return;
  const { costUsd, resolvedRates } = priceCall(usage, rates);
  attachPartialSpend(err, { usage, costUsd, rates: resolvedRates });
}

/**
 * Runs one round trip; if it throws, prices whatever it was billed first and
 * attaches that to the error, which is rethrown untouched. A wrapper (rather
 * than a catch at the call site) keeps `sendTurn` under the complexity ratchet.
 */
export async function billedOnFailure<T>(rates: Pricing, roundTrip: () => Promise<T>): Promise<T> {
  try {
    return await roundTrip();
  } catch (err) {
    recordFailedRoundTripSpend(err, rates);
    throw err;
  }
}
