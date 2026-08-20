import type { AdapterFailure } from "@/context/engine";
import { getSafeLogger } from "../../logger";
import type { RetryContext, RetryDecision, RetryStrategy } from "./types";

/**
 * Composes multiple RetryStrategy instances with first-match-wins semantics.
 *
 * Iterates through strategies in order, consulting each one's shouldRetry.
 * Returns the first decision with retry=true, or { retry: false } if all strategies decline.
 *
 * - Order matters: list strategies most specific first.
 * - Each strategy is single-purpose and should ignore failures outside its remit by returning { retry: false }.
 * - Stops consulting after the first match (no delay-merging, no decision-merging).
 */
export function composeRetry(strategies: readonly RetryStrategy[]): RetryStrategy {
  if (strategies.length === 0) {
    getSafeLogger()?.debug(
      "retry",
      "composeRetry called with empty strategies array — will always return { retry: false }",
    );
  }
  return {
    shouldRetry(failure: AdapterFailure | Error, attempt: number, ctx: RetryContext): RetryDecision {
      for (const strategy of strategies) {
        const decision = strategy.shouldRetry(failure, attempt, ctx);
        if (decision.retry) {
          return decision;
        }
      }
      return { retry: false };
    },
  };
}
