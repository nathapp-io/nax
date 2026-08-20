import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { UserStory } from "../../../src/prd/types";
import { _callOpDeps } from "../../../src/operations";
import { resolveRouting, tryLlmBatchRoute } from "../../../src/routing/router";
import { makeMockAgentManager, makeNaxConfig, makeStory } from "../../helpers";
import { makeMockRuntime } from "@test/helpers";
import type { DispatchContext } from "../../../src/runtime/dispatch-context";
import type { NaxRuntime } from "../../../src/runtime";

// The mock runtime makes the routing LLM call fail, which the classify-route op
// retries behind a 1s base backoff. The retry cadence is classify-route's
// contract, not this file's — stub the sleep out so the swallow-the-failure
// assertions don't pay it in wall-clock.
let origSleep: typeof _callOpDeps.sleep;

const createdRuntimes: NaxRuntime[] = [];
beforeEach(() => {
  origSleep = _callOpDeps.sleep;
  _callOpDeps.sleep = async () => {};
});
afterEach(async () => {
  _callOpDeps.sleep = origSleep;
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

describe("tryLlmBatchRoute", () => {
  test("uses _deps.runtime when provided and stories need routing", async () => {
    const config = makeNaxConfig({
      routing: {
        strategy: "llm",
        adaptive: { minSamples: 10, costThreshold: 0.8, fallbackStrategy: "keyword" },
        llm: { model: "fast", fallbackToKeywords: true, cacheDecisions: false, mode: "hybrid", timeoutMs: 5000 },
      },
    });
    const story = makeStory();
    const runtime = makeMockRuntime({ config });
    createdRuntimes.push(runtime);

    const deps = {
      agentManager: undefined,
      runtime,
    };

    // Should not throw — runtime is available (LLM call will fail due to mock, but that is caught and swallowed)
    await tryLlmBatchRoute(config, [story], "routing", deps);
  });

  test("returns early without error when _deps.runtime is undefined", async () => {
    const config = makeNaxConfig({
      routing: {
        strategy: "llm",
        adaptive: { minSamples: 10, costThreshold: 0.8, fallbackStrategy: "keyword" },
        llm: { model: "fast", fallbackToKeywords: true, cacheDecisions: false, mode: "hybrid", timeoutMs: 5000 },
      },
    });
    const story = makeStory();

    const deps = {
      agentManager: undefined,
      runtime: undefined,
    };

    // Should not throw — simply returns early
    await expect(tryLlmBatchRoute(config, [story], "routing", deps)).resolves.toBeUndefined();
  });

  test("returns early when no stories require routing (all pre-routed)", async () => {
    const config = makeNaxConfig({
      routing: {
        strategy: "llm",
        adaptive: { minSamples: 10, costThreshold: 0.8, fallbackStrategy: "keyword" },
        llm: { model: "fast", fallbackToKeywords: true, cacheDecisions: false, mode: "hybrid", timeoutMs: 5000 },
      },
    });
    const story: UserStory = {
      ...makeStory(),
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "already routed",
      },
    };

    // Even with runtime set, should return early since no routing needed
    const inlineRuntime = makeMockRuntime({ config });
    createdRuntimes.push(inlineRuntime);
    const deps = {
      agentManager: undefined,
      runtime: inlineRuntime,
    };

    await expect(tryLlmBatchRoute(config, [story], "routing", deps)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveRouting <-> runtime.routingCache instance-identity (BUG-19)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveRouting reads runtime.routingCache, scoped per runtime instance", () => {
  const cacheConfig = makeNaxConfig({
    routing: {
      strategy: "llm",
      llm: { model: "fast", fallbackToKeywords: true, cacheDecisions: true, mode: "hybrid", timeoutMs: 5000 },
    },
  });

  function makeDispatchContext(runtime: NaxRuntime): DispatchContext {
    return {
      agentManager: runtime.agentManager,
      sessionManager: runtime.sessionManager,
      runtime,
      abortSignal: runtime.signal,
    };
  }

  test("a cache hit on this runtime's routingCache never calls the agent", async () => {
    const completeAsFn = mock(async () => {
      throw new Error("should not be called — cache hit expected");
    });
    const runtime = makeMockRuntime({
      config: cacheConfig,
      agentManager: makeMockAgentManager({ completeAsFn }),
    });
    createdRuntimes.push(runtime);

    runtime.routingCache.set("US-cache-hit", {
      complexity: "complex",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "pre-cached",
    });
    const story: UserStory = { ...makeStory(), id: "US-cache-hit" };

    const decision = await resolveRouting(story, cacheConfig, undefined, makeDispatchContext(runtime));

    expect(decision.complexity).toBe("complex");
    expect(decision.modelTier).toBe("powerful");
    expect(completeAsFn).not.toHaveBeenCalled();
  });

  test("an entry cached on one runtime is invisible to resolveRouting on a different runtime", async () => {
    const runtimeA = makeMockRuntime({ config: cacheConfig });
    const completeAsFn = mock(async () => ({
      output: JSON.stringify({ complexity: "simple", modelTier: "fast", reasoning: "fresh classification" }),
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
    }));
    const runtimeB = makeMockRuntime({
      config: cacheConfig,
      agentManager: makeMockAgentManager({ completeAsFn }),
    });
    createdRuntimes.push(runtimeA, runtimeB);

    // Populated on runtime A only — the BUG-19 scenario is a decision cached
    // under one runtime being served back under an unrelated one.
    runtimeA.routingCache.set("US-cross-runtime", {
      complexity: "complex",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "cached on runtime A",
    });
    const story: UserStory = { ...makeStory(), id: "US-cross-runtime" };

    const decision = await resolveRouting(story, cacheConfig, undefined, makeDispatchContext(runtimeB));

    // runtimeB's cache is empty, so resolveRouting must fall through to real
    // classification instead of returning runtime A's cached decision.
    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
    expect(completeAsFn).toHaveBeenCalledTimes(1);
    expect(runtimeB.routingCache.has("US-cross-runtime")).toBe(true);
    expect(runtimeA.routingCache.get("US-cross-runtime")?.complexity).toBe("complex");
  });
});
