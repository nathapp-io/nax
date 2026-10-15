/**
 * Spend billed by a round trip that then failed.
 *
 * A failed or aborted request still bills the tokens it streamed (nax-ai's
 * `partialUsageOf`). The adapter's `complete` closure is the only place that
 * can price them, but it can only throw, so the priced spend rides on the
 * thrown error's identity (a WeakMap, like `turn-spend.ts`) and the turn loop's
 * `completeWithRecovery` folds it into the turn accumulator. `take` removes the
 * entry, so an error reaching the fold twice cannot count twice.
 */
import type { PricingRates, TokenUsage } from "#src/cost/standard-types";

export interface PartialSpend {
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly rates?: PricingRates;
}

const partialByError = new WeakMap<object, PartialSpend>();

/** Attaches the priced partial spend of a failed round trip to the error it threw. */
export function attachPartialSpend(err: unknown, spend: PartialSpend): void {
  if (typeof err === "object" && err !== null) partialByError.set(err, spend);
}

/** Removes and returns the partial spend attached to `err`, if any. */
export function takePartialSpend(err: unknown): PartialSpend | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const spend = partialByError.get(err);
  partialByError.delete(err);
  return spend;
}
