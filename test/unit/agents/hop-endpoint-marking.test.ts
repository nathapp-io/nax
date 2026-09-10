import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { AgentManager } from "@/agents";
import type { RetryDecision, RetryStrategy } from "@/agents/retry";
import { DEFAULT_CONFIG } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { AdapterFailure } from "@/context/engine";

// No fallback rungs are exhausted mid-test, but a never-retry strategy keeps a
// stray rate-limit exhaustion from parking the test on a real backoff sleep.
const neverRetry: RetryStrategy = {
  shouldRetry(): RetryDecision {
    return { retry: false };
  },
};

const RATE_LIMIT: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  retriable: true,
  message: "429",
};

function ladderConfig() {
  return makeNaxConfig({
    agent: {
      default: "native",
      protocol: "hybrid",
      fallback: {
        enabled: true,
        map: { native: [{ agent: "native", model: "powerful" }, "claude"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
    models: { native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" } },
  });
}

function runOptions(): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "unknown", model: "minimax/MiniMax-M3" },
    timeoutSeconds: 60,
    storyId: "US-1",
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
  };
}

describe("a failed hop marks the endpoint it dispatched", () => {
  test("a tier-less primary that dispatched balanced cools balanced, not the whole agent", async () => {
    const config = ladderConfig();
    const mgr = new AgentManager(config, undefined, { models: config.models, retryStrategy: neverRetry });
    const chain: string[] = [];

    await mgr.runWithFallback({
      runOptions: runOptions(),
      executeHop: async (agent, bundle, kind) => {
        chain.push(`${agent}:${kind.kind}`);
        const model = chain.length === 1 ? "minimax/MiniMax-M3" : "opencode-go/deepseek-v4-flash[high]";
        return {
          result: {
            success: false,
            exitCode: 1,
            output: "429",
            rateLimited: true,
            durationMs: 1,
            estimatedCostUsd: 0,
            adapterFailure: RATE_LIMIT,
          },
          bundle,
          endpoint: { modelDef: { provider: "unknown", model } },
        };
      },
    });

    // The primary's own endpoint is cooling, keyed on the model it dispatched...
    expect(mgr.isUnavailable("native", "balanced")).toBe(true);
    // ...as is the rung it swapped to — a DIFFERENT identity, not the same bare key.
    expect(mgr.isUnavailable("native", "powerful")).toBe(true);
    // And the ladder was still walked: the bare-agent key did not blanket it.
    expect(chain).toEqual(["native:primary", "native:swap", "claude:swap"]);
  });
});
