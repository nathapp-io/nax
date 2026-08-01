import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UserStory } from "../../../src/prd/types";
import { _callOpDeps } from "../../../src/operations";
import { tryLlmBatchRoute } from "../../../src/routing/router";
import { makeNaxConfig, makeStory } from "../../helpers";
import { makeMockRuntime } from "../../helpers/runtime";
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
