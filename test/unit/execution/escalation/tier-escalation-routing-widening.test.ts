/**
 * #1761 — EscalationHandlerContext.routing widened to RoutingDecision.
 *
 * `routing` was declared as `{ modelTier: string; testStrategy: string }`,
 * narrower than what the sole production call site
 * (`src/execution/pipeline-result-handler.ts`) ever passes — a full
 * `RoutingDecision` (`complexity` required). That mismatch forced an
 * cast to `UserStory` at the end of the escalation mapper in
 * `tier-escalation.ts` to launder a story whose inherited routing was
 * statically missing `complexity`.
 *
 * These are characterization tests for the fix: the mapper's returned
 * `UserStory` typechecks with no cast, and a story with no `routing` of its
 * own inherits `complexity` from the batch lead's routing (`ctx.routing`) at
 * runtime — the behaviour the widened type now describes accurately.
 *
 * Test naming convention follows the sibling files in
 * `test/unit/execution/escalation/` (split by describe-block concern per the
 * 800-line test-file cap).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeEscalationContext, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import { _tierEscalationDeps, handleTierEscalation } from "@/execution/escalation/tier-escalation";
import type { UserStory } from "@/prd";

let origSavePRD: typeof _tierEscalationDeps.savePRD;

beforeEach(() => {
  origSavePRD = _tierEscalationDeps.savePRD;
  _tierEscalationDeps.savePRD = () => Promise.resolve();
});

afterEach(() => {
  _tierEscalationDeps.savePRD = origSavePRD;
});

describe("#1761 — escalation mapper returns UserStory with no cast", () => {
  test("the escalated story assigns to UserStory with no cast", async () => {
    const story = makeStory({
      id: "US-no-cast",
      title: "Story",
      status: "in-progress",
      attempts: 1,
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    const result = await handleTierEscalation(
      makeEscalationContext({
        story,
        storiesToExecute: [story],
        isBatchExecution: false,
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
        pipelineResult: { reason: "Tests failed", context: {} },
        prd: makePRD({ userStories: [story] }),
      }),
    );

    const updated = result.prd.userStories.find((s) => s.id === "US-no-cast");
    assertDefined(updated, "escalated story missing from PRD");

    // Compile-time proof: no cast to `UserStory` (or any other type) is
    // needed here. Before #1761 this required a cast at the mapper's return site
    // because a routing-less story's inherited routing was statically a
    // partial StoryRouting (missing `complexity`).
    const typedStory: UserStory = updated;
    expect(typedStory.id).toBe("US-no-cast");
  });
});

describe("#1761 — routing-less story inherits complexity from the batch lead", () => {
  test("a non-lead batch member with routing undefined inherits ctx.routing.complexity", async () => {
    const config = makeNaxConfig({
      autoMode: {
        escalation: {
          enabled: true,
          tierOrder: [
            { tier: "fast", attempts: 1 },
            { tier: "balanced", attempts: 2 },
          ],
          escalateEntireBatch: true,
          resetMode: "initial",
        },
      },
      routing: { llm: { mode: "per-story" }, strategy: "keyword" },
      models: {},
    });

    const lead = makeStory({
      id: "US-lead-inherit",
      title: "Lead",
      status: "in-progress",
      attempts: 1,
      routing: { complexity: "complex", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });
    // Non-lead batch member with no routing of its own — the shape that
    // forced `baseRouting = s.routing ?? { ...ctx.routing }` to fall back to
    // ctx.routing, and previously typechecked only via a cast to `UserStory`.
    const nonLead = makeStory({
      id: "US-follower-inherit",
      title: "Follower with no routing",
      status: "in-progress",
      attempts: 1,
    });

    const result = await handleTierEscalation(
      makeEscalationContext({
        story: lead,
        storiesToExecute: [lead, nonLead],
        isBatchExecution: true,
        // The batch lead's full RoutingDecision, as forwarded by
        // pipeline-result-handler.ts (`routing: ctx.routing`).
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "complex", reasoning: "lead-decision" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config,
        prd: makePRD({ userStories: [lead, nonLead] }),
      }),
    );

    expect(result.outcome).toBe("escalated");

    const updatedFollower = result.prd.userStories.find((s) => s.id === "US-follower-inherit");
    assertDefined(updatedFollower, "follower story missing from PRD");

    // Runtime pin: complexity is inherited from the batch lead's routing
    // decision, not silently dropped — the fact the widened type now states.
    expect(updatedFollower.routing?.complexity).toBe("complex");
    expect(updatedFollower.routing?.modelTier).toBe("balanced");
  });
});
