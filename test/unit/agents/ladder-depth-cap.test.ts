import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import { AgentManager } from "@/agents";
import type { RetryDecision, RetryStrategy } from "@/agents/retry";
import { DEFAULT_CONFIG } from "@/config";
import { agentManagerConfigSelector } from "@/config/selectors";
import type { AdapterFailure, ContextBundle } from "@/context/engine";

// Every hop in this suite fails with a rate limit and the ladder is walked to its
// cap by design; a never-retry strategy keeps the terminal rate-limit exhaustion
// from parking the test on a real backoff sleep (see hop-endpoint-marking.test.ts).
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

function manager() {
  const config = makeNaxConfig({
    agent: {
      default: "native",
      protocol: "hybrid",
      fallback: {
        enabled: true,
        map: {
          native: [
            { agent: "native", model: "powerful" },
            { agent: "native", model: "openrouter/z-ai/glm-5.3-flash[high]" },
            "claude",
          ],
        },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: false,
      },
    },
    models: { native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" } },
  });
  return new AgentManager(config, undefined, { models: config.models, retryStrategy: neverRetry });
}

function runOptions(storyId: string): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "unknown", model: "minimax/MiniMax-M3" },
    timeoutSeconds: 60,
    storyId,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
  };
}

/** Every hop fails with a rate limit, so the ladder is walked to its cap. */
function failingHop(seen: string[]) {
  return async (agent: string, bundle: ContextBundle | undefined) => {
    seen.push(agent);
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
      endpoint: { modelDef: { provider: "unknown", model: `m${seen.length}` } },
    };
  };
}

describe("ladder depth cap", () => {
  test("an op starting at depth 1 may descend to 2 and no further", async () => {
    const seen: string[] = [];
    const outcome = await manager().runWithFallback({
      runOptions: runOptions("US-1"),
      startDepth: 1,
      executeHop: failingHop(seen),
    });

    // Started on rung 1, descended to rung 2, then the cap refused rung 3.
    expect(seen).toHaveLength(2);
    expect(outcome.finalDepth).toBe(2);
  });

  test("an op starting at depth 0 descends twice", async () => {
    const seen: string[] = [];
    const outcome = await manager().runWithFallback({
      runOptions: runOptions("US-2"),
      startDepth: 0,
      executeHop: failingHop(seen),
    });

    expect(seen).toHaveLength(3);
    expect(outcome.finalDepth).toBe(2);
  });

  test("depth is per story, not accumulated from another story's swaps", async () => {
    const mgr = manager();
    const first: string[] = [];
    await mgr.runWithFallback({ runOptions: runOptions("US-A"), startDepth: 0, executeHop: failingHop(first) });

    const second: string[] = [];
    await mgr.runWithFallback({ runOptions: runOptions("US-B"), startDepth: 0, executeHop: failingHop(second) });

    expect(second).toHaveLength(3);
  });

  // nax#1965 fix-round-1 CRITICAL 1: a story's sticky slot can pin a primary
  // agent that is NOT config.agent.default (resolveDispatchTarget passes it as
  // primaryAgentOverride — call-resolvers.ts). depthOf must root the ladder walk
  // on THAT agent, not on getDefault() — otherwise every candidate is looked up
  // in the wrong (often nonexistent) ladder, reads as depth 0, and nextCandidate
  // returns null on the very first failure: fallback silently disabled, no error,
  // no log.
  test("a sticky non-default primary agent still descends its OWN ladder", async () => {
    const config = makeNaxConfig({
      agent: {
        default: "claude", // deliberately NOT the sticky slot's agent below
        protocol: "hybrid",
        fallback: {
          enabled: true,
          // "claude" (the configured default) has no ladder entry at all here —
          // if depthOf ever roots on getDefault() instead of the agent actually
          // being walked, every rung below reads as depth 0.
          map: { native: [{ agent: "native", model: "powerful" }, "claude"] },
          maxHopsPerStory: 2,
          onQualityFailure: false,
          rebuildContext: false,
        },
      },
      models: { native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" } },
    });
    const mgr = new AgentManager(config, undefined, { models: config.models, retryStrategy: neverRetry });
    const seen: string[] = [];

    const outcome = await mgr.runWithFallback(
      { runOptions: runOptions("US-STICKY"), startDepth: 0, executeHop: failingHop(seen) },
      "native", // the sticky slot's primary — overrides config.agent.default ("claude")
    );

    // native's own 2-rung ladder must be walked to its cap, exactly as when
    // native is the configured default ("an op starting at depth 0 descends
    // twice" above). Before the fix this returned after ONE hop with
    // finalDepth 0 — nextCandidate looked up "claude"'s (nonexistent) ladder.
    expect(seen).toHaveLength(3);
    expect(outcome.finalDepth).toBe(2);
  });
});
