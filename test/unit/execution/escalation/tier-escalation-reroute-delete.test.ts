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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeEscalationContext,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
} from "@test/helpers";
import type { EscalationHandlerContext } from "@/execution/escalation/tier-escalation";
import { _tierEscalationDeps, handleTierEscalation } from "@/execution/escalation/tier-escalation";
import { resolveOperatingTier, resolveRouting } from "@/routing";
import type { NaxRuntime } from "@/runtime";
import type { DispatchContext } from "@/runtime/dispatch-context";

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
// ---------------------------------------------------------------------------

describe("#1710 — handleTierEscalation does not LLM-re-route", () => {
  test("batch escalation with a routing-less non-lead member and a runtime does not dispatch an LLM", async () => {
    const completeAsFn = mock(async () => {
      throw new Error("LLM dispatch must not occur during escalation");
    });
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
      routing: { strategy: "llm", llm: { mode: "hybrid" } },
      models: {},
    });
    const runtime = makeMockRuntime({ config, agentManager: makeMockAgentManager({ completeAsFn }) });
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
    });

    const result = await handleTierEscalation(
      makeEscalationContext({
        story: lead,
        storiesToExecute: [lead, nonLead],
        isBatchExecution: true,
        routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
        pipelineResult: { reason: "Tests failed", context: {} },
        config,
        prd: makePRD({ userStories: [lead, nonLead] }),
        runtime,
      }),
    );

    expect(result.outcome).toBe("escalated");
    expect(completeAsFn).not.toHaveBeenCalled();
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
  test("an escalated tier wins over a lower-tier routing cache entry", async () => {
    const config = makeNaxConfig({
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
      routing: {
        strategy: "llm",
        llm: { mode: "hybrid", cacheDecisions: true, fallbackToKeywords: true },
      },
      models: {},
    });
    const runtime = makeMockRuntime({ config });
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
      routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
      pipelineResult: { reason: "Tests failed", context: {} },
      config,
      prd: makePRD({ userStories: [story] }),
    });

    runtime.routingCache.set(story.id, {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "lower-tier cached decision",
    });

    const result = await handleTierEscalation(ctx);

    expect(result.outcome).toBe("escalated");
    // The story reference itself is not mutated by handleTierEscalation —
    // it returns a new PRD with the updated routing on the corresponding
    // userStories entry.
    const escalatedStory = result.prd.userStories.find((s) => s.id === story.id);
    expect(escalatedStory?.routing?.modelTier).toBe("balanced");
    if (!escalatedStory) throw new Error("Expected escalated story in returned PRD");

    const decision = await resolveRouting(escalatedStory, config, undefined, makeDispatchContext(runtime));
    const operating = resolveOperatingTier({
      previousTier: escalatedStory.routing?.modelTier,
      derivedTier: decision.modelTier,
      hasEscalationRecords: escalatedStory.escalations.length > 0,
    });
    expect(operating.tier).toBe("balanced");
  });
});

function makeDispatchContext(runtime: NaxRuntime): DispatchContext {
  return {
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    runtime,
    abortSignal: runtime.signal,
  };
}

// ---------------------------------------------------------------------------
// #1745 / #1761 — INJECT-ed non-lead story inherits complexity from the lead
//
// Characterization of the former defect #1745: an INJECT-ed non-lead batch
// member (routing: undefined) reaches escalation with no routing, and the
// `baseRouting = s.routing ?? { ...ctx.routing }` fallback inside
// `handleTierEscalation` used to write a `StoryRouting` permanently missing
// the type-required `complexity` — reachable only because
// `EscalationHandlerContext.routing` was declared narrower than what it was
// actually given. #1761 widened `EscalationHandlerContext.routing` to
// `RoutingDecision` (`complexity` required), so `ctx.routing` can no longer
// be constructed without `complexity`, and the fallback now always carries
// it through. Per this test's own prior comment: "When #1745 lands and
// routing is defaulted at inject time (or `EscalationHandlerContext.routing`
// gains `complexity`), this test will fail and should be updated rather than
// deleted."
// ---------------------------------------------------------------------------

describe("#1745 / #1761 — INJECT-ed non-lead story inherits complexity from the lead", () => {
  test("non-lead routing-less story inherits routing.complexity from ctx.routing after batch escalation", async () => {
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
      routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "test-fixture" },
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
    // #1761: the non-lead story now inherits complexity from ctx.routing —
    // the escalation context's own routing decision, which is deliberately
    // "medium" here while the lead story's persisted routing is "simple", so
    // this assertion discriminates the two sources — via the
    // `s.routing ?? { ...ctx.routing }`
    // fallback — no longer latched at undefined.
    expect(resultNonLead?.routing?.complexity).toBe("medium");
  });
});
