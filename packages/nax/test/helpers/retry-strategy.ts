import type { RetryStrategy } from "@/agents/retry";

function isRetryStrategy(retry: unknown): retry is RetryStrategy {
  return typeof retry === "object" && retry !== null && "shouldRetry" in retry;
}

/** Narrow an op's `retry` field to the strategy form, without a cast. */
export function expectRetryStrategy(retry: unknown): RetryStrategy {
  if (!isRetryStrategy(retry)) throw new Error("expected a RetryStrategy");
  return retry;
}
