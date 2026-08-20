import type { PipelineStage } from "@/config/permissions";
import type { AdapterFailure } from "@/context/engine";
import type { TurnResult } from "../types";

export type RetryDecision =
  | { retry: false; fallback?: unknown }
  | { retry: true; delayMs: number; nextPrompt?: string };

export interface RetryContext {
  readonly site: "run" | "complete";
  readonly agentName: string;
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly lastOutput?: string;
  readonly lastTurnResult?: TurnResult;
}

export interface RetryStrategy {
  /**
   * Called by `callOp` after each LLM turn to decide whether to retry.
   *
   * **Probe semantics (run-kind ops with `sendWithParseRetry`):**
   * The strategy always receives a synthetic `ParseValidationError` probe — it never
   * receives an error from `op.parse()`. Strategies MUST re-parse `ctx.lastOutput`
   * internally (e.g. via `tryParseLLMJson`) to determine whether the output is valid.
   * Returning `{ retry: true }` without checking `ctx.lastOutput` causes over-retry on
   * valid outputs.
   *
   * **Complete-kind ops:** Receives the real thrown error (parse error, transport error,
   * or AdapterFailure). No re-parse needed — the error is authoritative.
   */
  shouldRetry(
    failure: AdapterFailure | Error,
    /** Zero-based count of retries already attempted. 0 = deciding on first retry. */
    attempt: number,
    ctx: RetryContext,
  ): RetryDecision;
}

/**
 * Sentinel error passed to RetryStrategy.shouldRetry when an LLM call
 * succeeded but the produced output failed downstream validation
 * (e.g. invalid JSON shape, schema mismatch). Strategies that don't care
 * about validation failures can `instanceof` discriminate and ignore.
 */
export class ParseValidationError extends Error {
  // `declare` emits no class field initializer — Object.defineProperty below is the
  // single runtime assignment, making `kind` truly non-writable at runtime.
  declare readonly kind: "parse-validation";

  constructor(message: string) {
    super(message);
    this.name = "ParseValidationError";
    Object.defineProperty(this, "kind", {
      value: "parse-validation" as const,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
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
