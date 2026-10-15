/**
 * #2554 item 10: every tier-escalation status write (escalated tier, terminal
 * failure) goes through savePrdProgress so prd.json is committed (#2533).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeEscalationContext, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import { _tierEscalationDeps, handleTierEscalation, preIterationTierCheck } from "@/execution/escalation";

type Call = { path: string; storyId: string; label: string };

const original = _tierEscalationDeps.savePrdProgress;
let calls: Call[];

beforeEach(() => {
  calls = [];
  _tierEscalationDeps.savePrdProgress = async (_prd, path, storyId, label) => {
    calls.push({ path, storyId, label });
  };
});

afterEach(() => {
  _tierEscalationDeps.savePrdProgress = original;
});

const routing = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "t" } as const;

describe("tier escalation commits PRD status writes (#2554)", () => {
  test("preIterationTierCheck escalation saves via savePrdProgress", async () => {
    const story = makeStory({ id: "US-001", status: "in-progress", attempts: 1, routing });
    const prd = makePRD({ userStories: [story] });
    const config = makeNaxConfig({
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [
            { tier: "fast", attempts: 1 },
            { tier: "balanced", attempts: 1 },
          ],
        },
      },
      routing: { llm: { mode: "per-story" } },
    });

    await preIterationTierCheck(story, routing, config, prd, "/p/prd.json", undefined, { hooks: {} }, "f", 0, "/tmp");

    expect(calls).toEqual([{ path: "/p/prd.json", storyId: "US-001", label: "escalated" }]);
  });

  test("preIterationTierCheck terminal failure saves via savePrdProgress", async () => {
    const story = makeStory({ id: "US-002", status: "in-progress", attempts: 1, routing });
    const prd = makePRD({ userStories: [story] });
    const config = makeNaxConfig({
      autoMode: { escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 1 }] } },
      routing: { llm: { mode: "per-story" } },
    });

    await preIterationTierCheck(story, routing, config, prd, "/p/prd.json", undefined, { hooks: {} }, "f", 0, "/tmp");

    expect(calls).toEqual([{ path: "/p/prd.json", storyId: "US-002", label: "failed" }]);
  });

  test("handleTierEscalation escalation saves via savePrdProgress", async () => {
    const story = makeStory({ id: "US-003", status: "in-progress", attempts: 1, routing });
    const prd = makePRD({ feature: "f", userStories: [story] });
    const result = await handleTierEscalation(
      makeEscalationContext({
        story,
        prd,
        pipelineResult: { reason: "Test failure", context: {} },
        config: makeNaxConfig({
          autoMode: {
            escalation: {
              enabled: true,
              tierOrder: [
                { tier: "fast", attempts: 2 },
                { tier: "balanced", attempts: 3 },
              ],
            },
          },
          routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        }),
        prdPath: "/p/prd.json",
      }),
    );

    expect(result.outcome).toBe("escalated");
    expect(calls).toEqual([{ path: "/p/prd.json", storyId: "US-003", label: "escalated" }]);
  });
});
