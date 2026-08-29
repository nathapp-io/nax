import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import { _tierEscalationDeps, preIterationTierCheck } from "@/execution/escalation/tier-escalation";

let originalSavePRD: typeof _tierEscalationDeps.savePRD;

beforeEach(() => {
  originalSavePRD = _tierEscalationDeps.savePRD;
  _tierEscalationDeps.savePRD = () => Promise.resolve();
});

afterEach(() => {
  _tierEscalationDeps.savePRD = originalSavePRD;
});

describe("#1762 — pre-iteration escalation routing", () => {
  test("persists a complete resolved decision for an unrouted escalated story", async () => {
    const story = makeStory({ id: "US-1762", attempts: 1 });
    const prd = makePRD({ userStories: [story] });
    const resolvedRouting = {
      complexity: "complex" as const,
      modelTier: "fast" as const,
      testStrategy: "three-session-tdd" as const,
      reasoning: "resolved for injected story",
    };
    const resolveRoutingFn = mock(async () => resolvedRouting);

    const result = await preIterationTierCheck(
      story,
      { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "preview only" },
      makeNaxConfig({
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 1 },
              { tier: "balanced", attempts: 2 },
            ],
          },
        },
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        models: {},
      }),
      prd,
      "/tmp/prd-1762.json",
      undefined,
      { hooks: {} },
      "issue-1762",
      0,
      "/tmp",
      undefined,
      resolveRoutingFn,
    );

    expect(resolveRoutingFn).toHaveBeenCalledWith(story);
    expect(result.prd.userStories[0]?.routing).toEqual({ ...resolvedRouting, modelTier: "balanced" });
  });
});
