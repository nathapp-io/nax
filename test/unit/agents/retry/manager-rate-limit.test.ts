import { describe, expect, test } from "bun:test";
import { AgentManager, _agentManagerDeps } from "../../../../src/agents/manager";
import type { RetryContext, RetryDecision, RetryStrategy } from "../../../../src/agents/retry";
import type { AdapterFailure } from "../../../../src/context/engine";

const rateLimitFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "rate limited",
};

const baseConfig = {
  models: { claude: { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-6", powerful: "claude-opus-4-7" } },
  agent: { default: "claude", fallback: { enabled: false, map: {} } },
};

describe("AgentManager — injectable retryStrategy", () => {
  test("uses injected strategy instead of hardcoded logic when no swap candidates", async () => {
    const decisions: Array<{ attempt: number; failure: AdapterFailure | Error }> = [];
    const neverRetry: RetryStrategy = {
      shouldRetry(failure, attempt, _ctx): RetryDecision {
        decisions.push({ attempt, failure });
        return { retry: false };
      },
    };

    const sleepCalls: number[] = [];
    _agentManagerDeps.sleep = async (ms: number) => { sleepCalls.push(ms); };

    const manager = new AgentManager(baseConfig as never, undefined, { retryStrategy: neverRetry });

    const outcome = await manager.runWithFallback({
      runOptions: { prompt: "test", workdir: "/tmp", modelTier: "fast", modelDef: { model: "claude-haiku-4-5" }, config: baseConfig as never, pipelineStage: "run" },
      executeHop: async () => ({
        result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, adapterFailure: rateLimitFailure },
        bundle: undefined,
        prompt: undefined,
      }),
    });

    expect(outcome.result.success).toBe(false);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].attempt).toBe(0);
    expect(sleepCalls).toHaveLength(0);
  });

  test("defaultRetryStrategy fires 3 sleeps with exponential backoff", async () => {
    const sleepCalls: number[] = [];
    _agentManagerDeps.sleep = async (ms: number) => { sleepCalls.push(ms); };

    const manager = new AgentManager(baseConfig as never);

    await manager.runWithFallback({
      runOptions: { prompt: "test", workdir: "/tmp", modelTier: "fast", modelDef: { model: "claude-haiku-4-5" }, config: baseConfig as never, pipelineStage: "run" },
      executeHop: async () => ({
        result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, adapterFailure: rateLimitFailure },
        bundle: undefined,
        prompt: undefined,
      }),
    });

    expect(sleepCalls).toEqual([2000, 4000, 8000]);
  });
});
