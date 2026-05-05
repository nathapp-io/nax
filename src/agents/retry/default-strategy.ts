import type { AdapterFailure } from "../../context/engine";
import type { RetryContext, RetryDecision, RetryStrategy } from "./types";

const MAX_RETRIES = 3;

/**
 * Default manager-level retry strategy.
 *
 * Governs rate-limit backoff in `AgentManager.runWithFallback` when no swap
 * candidates are available (site #1). Fires only on `fail-rate-limit` outcomes;
 * all other failure types are returned as `{ retry: false }` so the caller
 * falls through to its normal exhaustion / error path.
 *
 * Backoff: 2^(attempt+1) * 1000ms → 2s, 4s, 8s across 3 retries.
 * This matches the original MAX_RATE_LIMIT_RETRIES = 3 behavior exactly.
 */
export const defaultRetryStrategy: RetryStrategy = {
  shouldRetry(failure: AdapterFailure | Error, attempt: number, _ctx: RetryContext): RetryDecision {
    if (attempt >= MAX_RETRIES) return { retry: false };
    if (failure instanceof Error) return { retry: false };
    const af = failure as AdapterFailure;
    if (af.outcome !== "fail-rate-limit") return { retry: false };
    const delayMs = 2 ** (attempt + 1) * 1000;
    return { retry: true, delayMs };
  },
};
