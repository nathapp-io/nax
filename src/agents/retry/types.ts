import type { PipelineStage } from "../../config/permissions";
import type { AdapterFailure } from "../../context/engine";

export type RetryDecision = { retry: false } | { retry: true; delayMs: number };

export interface RetryContext {
  readonly site: "run" | "complete";
  readonly agentName: string;
  readonly stage: PipelineStage;
  readonly storyId?: string;
}

export interface RetryStrategy {
  shouldRetry(
    failure: AdapterFailure | Error,
    /** Zero-based count of retries already attempted. 0 = deciding on first retry. */
    attempt: number,
    ctx: RetryContext,
  ): RetryDecision;
}

/**
 * Declarative retry configuration for `CompleteOperation.retry`.
 * `callOp` converts this to a `RetryStrategy` via `resolveRetryPreset`.
 *
 * - `maxAttempts`: total call attempts including the first (2 = 1 retry, 3 = 2 retries).
 * - `baseDelayMs`: fixed delay between attempts for "transient-network" preset.
 * - `preset: "transient-network"`: retry on any thrown Error or retriable AdapterFailure.
 */
export interface RetryPreset {
  readonly preset: "transient-network";
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
}
