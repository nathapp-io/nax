import type { AdapterFailure } from "../../context/engine";
import type { RetryContext, RetryDecision, RetryPreset, RetryStrategy } from "./types";

/**
 * Converts a declarative `RetryPreset` into a live `RetryStrategy`.
 *
 * "transient-network": retries on any thrown Error or retriable AdapterFailure
 * with a fixed baseDelayMs, up to (maxAttempts - 1) retries.
 */
export function resolveRetryPreset(preset: RetryPreset): RetryStrategy {
  return {
    shouldRetry(failure: AdapterFailure | Error, attempt: number, _ctx: RetryContext): RetryDecision {
      if (attempt >= preset.maxAttempts - 1) return { retry: false };
      if (preset.preset === "transient-network") {
        if (failure instanceof Error) return { retry: true, delayMs: preset.baseDelayMs };
        const af = failure as AdapterFailure;
        if (af.retriable) return { retry: true, delayMs: preset.baseDelayMs };
        return { retry: false };
      }
      return { retry: false };
    },
  };
}
