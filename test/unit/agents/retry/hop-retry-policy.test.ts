/**
 * US-002 — pure policy tests for `src/agents/retry/hop-retry-policy.ts`.
 *
 * These tests pin the contract that `extractTimeoutRetryConfig` reads from
 * `agent.timeoutRetry.{maxAttempts,budgetMultiplier}`, that
 * `resolveTimeoutRetryOptions` produces a new AgentRunOptions with the
 * reduced timeoutSeconds, and that `timeoutRetryShouldRetry` enforces the
 * budget cap. The stubs in `hop-retry-policy.ts` throw on call; once the
 * implementer wires these up, the assertions below guide them toward the
 * correct behavior.
 *
 * Boundary: when prior options lack timeoutSeconds (the hop type doesn't
 * carry one), the policy must resolve a sane value from
 * `config.execution?.sessionTimeoutSeconds` and apply the multiplier there.
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import {
  extractTimeoutRetryConfig,
  resolveTimeoutRetryOptions,
  type TimeoutRetryConfig,
  timeoutRetryShouldRetry,
} from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";

const TIMEOUT_RETRY_DEFAULTS: TimeoutRetryConfig = {
  maxAttempts: 1,
  budgetMultiplier: 0.5,
};

function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: DEFAULT_CONFIG,
    storyId: "US-002",
    ...overrides,
  } as AgentRunOptions;
}

describe("extractTimeoutRetryConfig — config policy extraction", () => {
  test("uses the on-config timeoutRetry values when both are set", () => {
    const config = agentManagerConfigSelector.select(
      makeNaxConfig({ agent: { timeoutRetry: { maxAttempts: 3, budgetMultiplier: 0.25 } } }),
    );
    const result = extractTimeoutRetryConfig(config);
    expect(result.maxAttempts).toBe(3);
    expect(result.budgetMultiplier).toBe(0.25);
  });

  test("boundary: returns defaults when agent.timeoutRetry is absent", () => {
    const config = agentManagerConfigSelector.select(makeNaxConfig({ agent: {} }));
    const result = extractTimeoutRetryConfig(config);
    expect(result.maxAttempts).toBe(1);
    expect(result.budgetMultiplier).toBe(0.5);
  });
});

describe("resolveTimeoutRetryOptions — multiplies the previous hop's timeoutSeconds", () => {
  test("timeoutSeconds=60 with budgetMultiplier=0.5 yields 30", () => {
    const opts = resolveTimeoutRetryOptions(makeRunOptions({ timeoutSeconds: 60 }), TIMEOUT_RETRY_DEFAULTS);
    expect(opts.timeoutSeconds).toBe(30);
  });

  test("boundary: 80 × 0.25 = 20 (budgetMultiplier applies to the prior hop's value)", () => {
    const opts = resolveTimeoutRetryOptions(makeRunOptions({ timeoutSeconds: 80 }), {
      maxAttempts: 1,
      budgetMultiplier: 0.25,
    });
    expect(opts.timeoutSeconds).toBe(20);
  });

  test("boundary: result is a fresh object, not a reference to the previous options", () => {
    const prev = makeRunOptions({ timeoutSeconds: 60 });
    const next = resolveTimeoutRetryOptions(prev, TIMEOUT_RETRY_DEFAULTS);
    expect(next).not.toBe(prev);
  });
});

describe("timeoutRetryShouldRetry — attempt-counter enforcement", () => {
  test("attempts=0, maxAttempts=1 → retry allowed", () => {
    expect(timeoutRetryShouldRetry(0, TIMEOUT_RETRY_DEFAULTS)).toBe(true);
  });

  test("boundary: attempts=1, maxAttempts=1 → no further retry (budget exhausted)", () => {
    expect(timeoutRetryShouldRetry(1, TIMEOUT_RETRY_DEFAULTS)).toBe(false);
  });

  test("boundary: maxAttempts=0 → no retry even at attempts=0", () => {
    expect(timeoutRetryShouldRetry(0, { maxAttempts: 0, budgetMultiplier: 0.5 })).toBe(false);
  });
});
