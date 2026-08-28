/**
 * #1710 — handleTierEscalation does not LLM-re-route, even when reachable.
 *
 * Characterization tests for the deletion in #1710. The reachable case is:
 * an INJECT-ed story as a non-lead member of a batch with `routing === undefined`
 * (separate defect #1745). With the call sites deleted from
 * `src/execution/escalation/tier-escalation.ts`, no billable
 * `classifyRouteBatchOp` dispatch should ever be reachable from
 * `handleTierEscalation` or `preIterationTierCheck`.
 *
 * These are regression guards — the bug is latent (the call sites were always
 * inert on main; see comment #4 on #1710, which notes #1707's runtime threading
 * left the pipeline site one tidy-up away from activating it). The invariants
 * hold today; the tests exist to catch re-introduction.
 *
 * Test naming convention follows the sibling files in
 * `test/unit/execution/escalation/` (split by describe-block concern per the
 * 800-line test-file cap).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeEscalationContext, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { EscalationHandlerContext } from "@/execution/escalation/tier-escalation";
import { _tierEscalationDeps, handleTierEscalation } from "@/execution/escalation/tier-escalation";

const TIER_ESCALATION_PATH = new URL("../../../../src/execution/escalation/tier-escalation.ts", import.meta.url)
  .pathname;

let origSavePRD: typeof _tierEscalationDeps.savePRD;

beforeEach(() => {
  origSavePRD = _tierEscalationDeps.savePRD;
  _tierEscalationDeps.savePRD = () => Promise.resolve();
});

afterEach(() => {
  _tierEscalationDeps.savePRD = origSavePRD;
});

// ---------------------------------------------------------------------------
// #1710 — handleTierEscalation does not LLM-re-route
//
// SOURCE-LEVEL GUARD: strongest regression check. If `tier-escalation.ts`
// doesn't import or call `tryLlmBatchRoute`, the function cannot be invoked
// from `handleTierEscalation` or `preIterationTierCheck`. This catches every
// shape of re-introduction (call site, dynamic import, helper wrapper).
// ---------------------------------------------------------------------------

describe("#1710 — handleTierEscalation does not LLM-re-route", () => {
  test("tier-escalation.ts source contains no tryLlmBatchRoute or hybrid-re-route reference", async () => {
    const source = await Bun.file(TIER_ESCALATION_PATH).text();
    expect(source).not.toContain("tryLlmBatchRoute");
    expect(source).not.toContain("hybrid-re-route");
  });
});

// ---------------------------------------------------------------------------
// #1710 — escalation writes the escalated tier to the result PRD
//
// Integration guard: the tier the escalated retry actually runs at is the
// next rung in tierOrder, written into the returned PRD's userStories entry.
// The `resolveOperatingTier` precedence rule (escalated tier wins over a
// lower-tier cache hit) is pinned at unit level in
// `test/unit/routing/operating-tier.test.ts`. This test pins the equivalent
// invariant on the `handleTierEscalation` write path — the next iteration
// will read `story.routing.modelTier` from this PRD and run at the escalated
// tier regardless of any prior cache state.
// ---------------------------------------------------------------------------

describe("#1710 — escalation writes the escalated tier to the result PRD", () => {
  test("after escalation, the story's routing.modelTier in the returned PRD reflects the escalated tier", async () => {
    const story = makeStory({
      id: "US-escalation-tier-write",
      title: "Story",
      status: "in-progress",
      attempts: 1,
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    const ctx: EscalationHandlerContext = makeEscalationContext({
      story,
      storiesToExecute: [story],
      isBatchExecution: false,
      routing: { modelTier: "fast", testStrategy: "test-after" },
      pipelineResult: { reason: "Tests failed", context: {} },
      config: makeNaxConfig({
        autoMode: {
          escalation: {
            enabled: true,
            tierOrder: [
              { tier: "fast", attempts: 1 },
              { tier: "balanced", attempts: 2 },
            ],
            escalateEntireBatch: false,
            resetMode: "initial",
          },
        },
        routing: { llm: { mode: "per-story" }, strategy: "keyword" },
        models: {},
      }),
      prd: makePRD({ userStories: [story] }),
    });

    const result = await handleTierEscalation(ctx);

    expect(result.outcome).toBe("escalated");
    // The story reference itself is not mutated by handleTierEscalation —
    // it returns a new PRD with the updated routing on the corresponding
    // userStories entry.
    const escalatedStory = result.prd.userStories.find((s) => s.id === story.id);
    expect(escalatedStory?.routing?.modelTier).toBe("balanced");
  });
});

// ---------------------------------------------------------------------------
// #1745 — INJECT-ed non-lead story latches with no complexity after batch escalation
//
// Characterization of the related defect #1745: an INJECT-ed non-lead batch
// member (routing: undefined) reaches escalation with no routing, and the
// `baseRouting = s.routing ?? { ...ctx.routing }` fallback inside
// `handleTierEscalation` writes a `StoryRouting` permanently missing the
// type-required `complexity`. After #1710's deletion, escalation still does
// NOT fix this — it persists. When #1745 lands and routing is defaulted at
// inject time (or `EscalationHandlerContext.routing` gains `complexity`),
// this test will fail and should be updated rather than deleted.
// ---------------------------------------------------------------------------

describe("#1745 — INJECT-ed non-lead story latches with no complexity after batch escalation", () => {
  test("non-lead routing-less story still has no routing.complexity after batch escalation", async () => {
    const lead = makeStory({
      id: "US-lead-reroute",
      title: "Lead",
      status: "in-progress",
      attempts: 1,
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });
    const nonLead = makeStory({
      id: "US-inject-reroute",
      title: "INJECT-shaped non-lead",
      status: "in-progress",
      attempts: 1,
      // routing === undefined — the #1745 reachable case
    });

    const ctx: EscalationHandlerContext = makeEscalationContext({
      story: lead,
      storiesToExecute: [lead, nonLead],
      isBatchExecution: true,
      routing: { modelTier: "fast", testStrategy: "test-after" },
      pipelineResult: { reason: "Tests failed", context: {} },
      config: makeNaxConfig({
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
        routing: { strategy: "llm", llm: { mode: "hybrid" } },
        models: {},
      }),
      prd: makePRD({ userStories: [lead, nonLead] }),
    });

    const result = await handleTierEscalation(ctx);

    // Assert on the returned PRD's userStories entry, not the input
    // reference — handleTierEscalation constructs a new PRD rather than
    // mutating the input stories. Same shape used by Test 2 above.
    const resultNonLead = result.prd.userStories.find((s) => s.id === nonLead.id);
    // The non-lead story should still have no routing.complexity — the
    // #1745 latch. Update rather than delete when #1745 is fixed.
    expect(resultNonLead?.routing?.complexity).toBeUndefined();
  });
});
