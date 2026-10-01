import type { AdapterFailure } from "@/context/engine";
import { failurePolicyFor } from "./failure-policy";
import type { RetryContext, RetryDecision, RetryStrategy } from "./types";

const MAX_RETRIES = 3;

/**
 * Default manager-level retry strategy.
 *
 * Governs backoff in `AgentManager` when a dispatch hits a terminal exit with
 * nowhere to go (site #1). Consults `failurePolicyFor` — the policy table's
 * `terminalBackoff` row decides which outcomes back off, currently
 * `fail-rate-limit`, `fail-stale`, and `fail-service-down`. All other failure
 * types are returned as `{ retry: false }` so the caller falls through to its
 * normal exhaustion / error path.
 *
 * Backoff: 2^(attempt+1) * 1000ms → 2s, 4s, 8s across 3 retries.
 * This matches the original MAX_RATE_LIMIT_RETRIES = 3 behavior exactly.
 * When the provider reports its own recovery time (`retryAfterSeconds`), that
 * delay replaces the computed backoff (see `shouldRetry`).
 */
export const defaultRetryStrategy: RetryStrategy = {
  shouldRetry(failure: AdapterFailure | Error, attempt: number, _ctx: RetryContext): RetryDecision {
    if (attempt >= MAX_RETRIES) return { retry: false };
    if (failure instanceof Error) return { retry: false };
    const af = failure as AdapterFailure;
    if (af.retriable === false) return { retry: false };
    if (!failurePolicyFor(af.outcome).terminalBackoff) return { retry: false };
    // The provider's own recovery time beats a guess. Populated by acpx
    // (parse-agent-error) and, since the native errors table takes the whole
    // protocol error, by native too. The attempt cap is unchanged -- a long
    // retryAfter buys a longer wait, never an extra attempt.
    const retryAfterSeconds = af.retryAfterSeconds;
    const delayMs =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : 2 ** (attempt + 1) * 1000;
    return { retry: true, delayMs };
  },
};
