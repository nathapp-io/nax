/**
 * The single terminal exit for a dispatch that cannot proceed.
 *
 * Before this module the rate-limit backoff lived *inside* the declined-swap
 * branch of `runWithFallback`, so a 429 that `decideSwap` accepted and then
 * found no candidate for died instantly — strictly worse than the same failure
 * being declined one branch away. `completeWithFallback` had no backoff at all
 * and never emitted `onSwapExhausted`.
 *
 * Backoff and the exhaustion event are separate concerns and do not fire
 * together. Backoff follows the failure's policy. The event fires only when a
 * swap was genuinely possible and had nowhere to go — a policy decline
 * (fallback disabled, quality declined, teardown) is not exhaustion, and
 * emitting there would displace the decline log as a distinct signal.
 */

import type { AdapterFailure } from "@/context/engine";
import { failurePolicyFor } from "./failure-policy";
import type { RetryContext, RetryStrategy } from "./types";

export type ExhaustionOutcome = "retry" | "exhausted" | "cancelled";

export interface ResolveExhaustionInput {
  readonly failure: AdapterFailure | undefined;
  readonly attempt: number;
  readonly hopsSoFar: number;
  /** True only when a swap was possible and had nowhere to go, or the hop cap was hit. */
  readonly swapWasPossible: boolean;
  readonly retryStrategy: RetryStrategy;
  readonly retryCtx: RetryContext;
  readonly signal?: AbortSignal;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onExhausted: (hops: number) => void;
}

export async function resolveExhaustion(input: ResolveExhaustionInput): Promise<ExhaustionOutcome> {
  const { failure, retryStrategy, retryCtx, signal, sleep, onExhausted } = input;
  if (signal?.aborted) return "cancelled";

  if (failure && failurePolicyFor(failure.outcome).terminalBackoff) {
    const decision = retryStrategy.shouldRetry(failure, input.attempt, retryCtx);
    if (decision.retry) {
      await sleep(decision.delayMs, signal);
      return signal?.aborted ? "cancelled" : "retry";
    }
  }

  if (input.swapWasPossible) onExhausted(input.hopsSoFar);
  return "exhausted";
}
