/**
 * Hop-level retry policy for fail-timeout bounded retry (US-002).
 *
 * - `extractTimeoutRetryConfig(config)` reads `agent.timeoutRetry.{maxAttempts,budgetMultiplier}`
 *   and fills in defaults (1, 0.5) when keys are absent.
 * - `resolveTimeoutRetryOptions(prev, timeoutConfig, executionConfig)` returns a new
 *   AgentRunOptions with `timeoutSeconds` reduced by the configured multiplier. Falls back
 *   to `execution.sessionTimeoutSeconds` when the prior hop's timeoutSeconds is unset.
 * - `timeoutRetryShouldRetry(attempts, config)` returns whether another hop may run.
 * - `trySameAgentRetry(result, state, deps)` consolidates fail-stale, fail-timeout,
 *   and fail-adapter-error retry decisions into a single function.
 */

import { DEFAULT_AGENT_TIMEOUT_RETRY_CONFIG, DEFAULT_CONFIG } from "@/config";
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
        reason?: string;
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
        reason?: string;
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
        retriable: boolean;
        maxAttempts: number;
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
        reason: result.adapterFailure?.reason,
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
        currentRunOptions: resolveTimeoutRetryOptions(
          currentRunOptions,
          timeoutConfig,
          config.execution,
          requestRunOptions,
        ),
        fallbackRecord: {
          outcome: result.adapterFailure?.outcome ?? "fail-timeout",
          category: result.adapterFailure?.category ?? "quality",
          costUsd: result.estimatedCostUsd ?? 0,
          reason: result.adapterFailure?.reason,
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
          retriable: result.adapterFailure?.retriable ?? false,
          maxAttempts: maxAdapterRetries,
        },
      };
    }
  }

  return null;
}

export function extractTimeoutRetryConfig(config: AgentManagerConfig): TimeoutRetryConfig {
  const fromConfig = config.agent?.timeoutRetry;
  return {
    maxAttempts: fromConfig?.maxAttempts ?? DEFAULT_AGENT_TIMEOUT_RETRY_CONFIG.maxAttempts,
    budgetMultiplier: fromConfig?.budgetMultiplier ?? DEFAULT_AGENT_TIMEOUT_RETRY_CONFIG.budgetMultiplier,
  };
}

export function resolveTimeoutRetryOptions(
  prev: AgentRunOptions,
  timeoutConfig: TimeoutRetryConfig,
  executionConfig?: { sessionTimeoutSeconds?: number },
  baseRunOptions?: AgentRunOptions,
): AgentRunOptions {
  // Always reduce from the ORIGINAL request budget, never from a previously-reduced
  // `prev.timeoutSeconds` — otherwise the budget compounds on every retry
  // (3600s -> 1800s -> 900s), making later retries time out faster than the
  // original failure they're supposed to recover from.
  const baseBudget = baseRunOptions?.timeoutSeconds ?? prev.timeoutSeconds;
  const budget = baseBudget ?? executionConfig?.sessionTimeoutSeconds ?? DEFAULT_CONFIG.execution.sessionTimeoutSeconds;
  return { ...prev, timeoutSeconds: budget * timeoutConfig.budgetMultiplier };
}

export function timeoutRetryShouldRetry(attempts: number, config: TimeoutRetryConfig): boolean {
  return attempts < config.maxAttempts;
}

export interface RetryLogEvent {
  /** adapter-error retries are same-agent reconnects, not swaps — never recorded as fallback hops. */
  recordFallback: boolean;
  level: "warn" | "info";
  message: string;
  fields: Record<string, unknown>;
}

/** Describes how to log a same-agent retry decision, without performing the logging itself. */
export function describeRetryLogEvent(
  retryDecision: Exclude<SameAgentRetryResult, null>,
  storyId: string | undefined,
  agent: string,
): RetryLogEvent {
  const attempt = retryDecision.kind.attempt;
  if (retryDecision.outcome === "adapter-error") {
    return {
      recordFallback: false,
      level: "warn",
      message: "fail-adapter-error: same-agent retry with fresh session",
      fields: {
        storyId,
        attempt,
        maxAttempts: retryDecision.fallbackRecord.maxAttempts,
        retriable: retryDecision.fallbackRecord.retriable,
        agent,
      },
    };
  }
  return {
    recordFallback: true,
    level: "info",
    message:
      retryDecision.outcome === "stale-retry"
        ? "fail-stale: immediate same-agent retry"
        : "fail-timeout: same-agent retry with reduced budget",
    fields: { storyId, attempt, agent, reason: retryDecision.fallbackRecord.reason },
  };
}
