/**
 * Hop-level retry policy stubs for fail-timeout bounded retry (US-002).
 *
 * The implementer will populate these with the real policy:
 * - `extractTimeoutRetryConfig(config)` reads `agent.timeoutRetry.{maxAttempts,budgetMultiplier}`
 *   and fills in defaults (1, 0.5) when keys are absent.
 * - `resolveTimeoutRetryOptions(prev, config)` returns a new AgentRunOptions
 *   with `timeoutSeconds` reduced by the configured multiplier.
 * - `timeoutRetryShouldRetry(attempts, config)` returns whether another hop may run.
 *
 * Until then, the stubs return placeholder values that fail the assertions in
 * `test/unit/agents/retry/hop-retry-policy.test.ts`, so the tests compile and
 * fail with assertion failures (not import or compile errors).
 */

import type { AgentManagerConfig } from "@/config";
import type { AdapterFailure } from "@/context";
import type { AgentResult, AgentRunOptions } from "../types";

export interface TimeoutRetryConfig {
  maxAttempts: number;
  budgetMultiplier: number;
}

export interface SameAgentRetryState {
  staleRetryAttempts: number;
  timeoutRetryAttempts: number;
  adapterErrorRetries: number;
  currentRunOptions: AgentRunOptions;
}

export type SameAgentRetryResult =
  | {
      outcome: "stale-retry";
      staleRetryAttempts: number;
      kind: { kind: "stale-retry"; attempt: number };
      fallbackRecord: {
        outcome: AdapterFailure["outcome"];
        category: AdapterFailure["category"];
        costUsd: number;
      };
    }
  | {
      outcome: "timeout-retry";
      timeoutRetryAttempts: number;
      kind: { kind: "timeout-retry"; attempt: number };
      currentRunOptions: AgentRunOptions;
      fallbackRecord: {
        outcome: AdapterFailure["outcome"];
        category: AdapterFailure["category"];
        costUsd: number;
      };
    }
  | {
      outcome: "adapter-error";
      adapterErrorRetries: number;
      kind: { kind: "stale-retry"; attempt: number };
      fallbackRecord: {
        outcome: AdapterFailure["outcome"];
        category: AdapterFailure["category"];
        costUsd: number;
      };
    }
  | null;

export interface TrySameAgentRetryDeps {
  config: AgentManagerConfig;
  requestRunOptions: AgentRunOptions;
  signal?: AbortSignal;
}

export function trySameAgentRetry(
  result: AgentResult,
  state: SameAgentRetryState,
  deps: TrySameAgentRetryDeps,
): SameAgentRetryResult {
  const { staleRetryAttempts, timeoutRetryAttempts, adapterErrorRetries, currentRunOptions } = state;
  const { config, requestRunOptions, signal } = deps;

  // fail-stale: same-agent retries up to maxRetryAttempts before swap or terminal failure.
  const isFailStale = result.adapterFailure?.outcome === "fail-stale";
  const maxStaleRetries = config.agent?.idleWatchdog?.maxRetryAttempts ?? 3;
  if (isFailStale && result.adapterFailure?.retriable && staleRetryAttempts < maxStaleRetries) {
    const newAttempts = staleRetryAttempts + 1;
    return {
      outcome: "stale-retry",
      staleRetryAttempts: newAttempts,
      kind: { kind: "stale-retry", attempt: newAttempts },
      fallbackRecord: {
        outcome: result.adapterFailure?.outcome ?? "fail-stale",
        category: result.adapterFailure?.category ?? "availability",
        costUsd: result.estimatedCostUsd ?? 0,
      },
    };
  }

  // fail-timeout: same-agent retry with reduced budget and fresh session.
  const isFailTimeout = result.adapterFailure?.outcome === "fail-timeout";
  if (isFailTimeout && result.adapterFailure?.retriable) {
    const timeoutConfig = extractTimeoutRetryConfig(config);
    if (timeoutRetryShouldRetry(timeoutRetryAttempts, timeoutConfig)) {
      const newAttempts = timeoutRetryAttempts + 1;
      return {
        outcome: "timeout-retry",
        timeoutRetryAttempts: newAttempts,
        kind: { kind: "timeout-retry", attempt: newAttempts },
        currentRunOptions: resolveTimeoutRetryOptions(currentRunOptions, timeoutConfig),
        fallbackRecord: {
          outcome: result.adapterFailure?.outcome ?? "fail-timeout",
          category: result.adapterFailure?.category ?? "quality",
          costUsd: result.estimatedCostUsd ?? 0,
        },
      };
    }
  }

  // fail-adapter-error: same-agent retry when acpx signals retryable.
  const isFailAdapterError = result.adapterFailure?.outcome === "fail-adapter-error";
  if (isFailAdapterError && !signal?.aborted) {
    const runConfig = requestRunOptions.config ?? config;
    const maxAdapterRetries = result.adapterFailure?.retriable
      ? (runConfig.execution?.sessionErrorRetryableMaxRetries ?? 3)
      : (runConfig.execution?.sessionErrorMaxRetries ?? 1);
    if (adapterErrorRetries < maxAdapterRetries) {
      const newAttempts = adapterErrorRetries + 1;
      return {
        outcome: "adapter-error",
        adapterErrorRetries: newAttempts,
        kind: { kind: "stale-retry", attempt: newAttempts },
        fallbackRecord: {
          outcome: result.adapterFailure?.outcome ?? "fail-adapter-error",
          category: result.adapterFailure?.category ?? "availability",
          costUsd: result.estimatedCostUsd ?? 0,
        },
      };
    }
  }

  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: config shape varies (AgentManagerConfig vs test objects)
export function extractTimeoutRetryConfig(config: Record<string, any>): TimeoutRetryConfig {
  const fromConfig = config.agent?.timeoutRetry;
  return {
    maxAttempts: fromConfig?.maxAttempts ?? 1,
    budgetMultiplier: fromConfig?.budgetMultiplier ?? 0.5,
  };
}

export function resolveTimeoutRetryOptions(prev: AgentRunOptions, config: TimeoutRetryConfig): AgentRunOptions {
  const budget = prev.timeoutSeconds ?? 60;
  return { ...prev, timeoutSeconds: Math.round(budget * config.budgetMultiplier) };
}

export function timeoutRetryShouldRetry(attempts: number, config: TimeoutRetryConfig): boolean {
  return attempts < config.maxAttempts;
}
