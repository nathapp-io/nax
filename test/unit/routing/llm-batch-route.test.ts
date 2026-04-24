import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../src/prd/types";
import { tryLlmBatchRoute } from "../../../src/routing/router";
import { makeMockAgentManager, makeNaxConfig, makeStory } from "../../helpers";

describe("tryLlmBatchRoute", () => {
  test("uses _deps.agentManager when provided and stories need routing", async () => {
    const config = makeNaxConfig({
      routing: {
        strategy: "llm",
        adaptive: { minSamples: 10, costThreshold: 0.8, fallbackStrategy: "keyword" },
        llm: { model: "fast", fallbackToKeywords: true, cacheDecisions: false, mode: "hybrid", timeoutMs: 5000 },
      },
    });
    const story = makeStory();
    const mockManager = makeMockAgentManager();

    const deps = {
      agentManager: mockManager,
    };

    // Should not throw — agentManager is available
    await tryLlmBatchRoute(config, [story], "routing", deps);
  });

  test("returns early without error when _deps.agentManager is undefined", async () => {
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

    // Even with agentManager set, should return early since no routing needed
    const deps = {
      agentManager: makeMockAgentManager(),
    };

    await expect(tryLlmBatchRoute(config, [story], "routing", deps)).resolves.toBeUndefined();
  });
});
