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
import { makeEscalationContext, makeMockRuntime, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { EscalationHandlerContext } from "@/execution/escalation/tier-escalation";
import { _tierEscalationDeps, handleTierEscalation } from "@/execution/escalation/tier-escalation";
import type { RoutingDecision } from "@/routing/decision";
import { injectCacheEntry } from "@/routing/strategies/llm-cache";
import type { NaxRuntime } from "@/runtime";

const TIER_ESCALATION_PATH = new URL("../../../../src/execution/escalation/tier-escalation.ts", import.meta.url)
  .pathname;

const createdRuntimes: NaxRuntime[] = [];
let origSavePRD: typeof _tierEscalationDeps.savePRD;

beforeEach(() => {
  origSavePRD = _tierEscalationDeps.savePRD;
  _tierEscalationDeps.savePRD = () => Promise.resolve();
});

afterEach(async () => {
  _tierEscalationDeps.savePRD = origSavePRD;
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
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
// #1710 — escalated tier wins over a lower-tier routingCache entry
//
// Integration guard: pre-populates `runtime.routingCache` with a lower-tier
// decision, escalates, and asserts the story runs at the escalated tier. Pins
// `resolveOperatingTier` precedence against future cache writers. The unit
// rule itself is covered in `test/unit/routing/operating-tier.test.ts`; this
// test pins it transitively through `handleTierEscalation`.
// ---------------------------------------------------------------------------

describe("#1710 — escalated tier wins over lower-tier routingCache entry", () => {
  test("after escalation, story.routing.modelTier reflects the escalated tier, not the cached lower tier", async () => {
    const story = makeStory({
      id: "US-cache-vs-escalation",
      title: "Story with stale cache",
      status: "in-progress",
      attempts: 1,
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    const runtime = makeMockRuntime({
      config: makeNaxConfig({
        routing: { strategy: "llm", llm: { mode: "hybrid", cacheDecisions: true } },
      }),
    });
    createdRuntimes.push(runtime);

    const staleDecision: RoutingDecision = {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "pre-cached lower-tier decision",
    };
    injectCacheEntry(runtime.routingCache, story.id, staleDecision);

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
        routing: { strategy: "llm", llm: { mode: "hybrid", cacheDecisions: true } },
        models: {},
      }),
      prd: makePRD({ userStories: [story] }),
      runtime,
    });

    const result = await handleTierEscalation(ctx);

    expect(result.outcome).toBe("escalated");
    // Escalation fast → balanced must win over the cached "fast" tier. The
    // story reference itself is not mutated by handleTierEscalation — it
    // returns a new PRD with the updated routing on the corresponding
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
// `baseRouting = s.routing ?? { ...ctx.routing }` fallback at
// `tier-escalation.ts:525` writes a `StoryRouting` permanently missing the
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

    await handleTierEscalation(ctx);

    // The non-lead story should still have no routing.complexity — the
    // #1745 latch. Update rather than delete when #1745 is fixed.
    expect(nonLead.routing?.complexity).toBeUndefined();
  });
});
