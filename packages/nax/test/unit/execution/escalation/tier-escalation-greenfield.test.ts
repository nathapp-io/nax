// RE-ARCH: keep
/**
 * S5: Strategy Fallback Tests — greenfield-no-tests → tdd-simple
 *
 * Moved from test/integration/context/ — pure logic, no integration surface.
 * Import goes to the leaf module, not runner.ts barrel, to avoid importing
 * heavy ACP/registry side-effects that can keep the Bun process alive.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertDefined,
  type LogCall,
  type MockLogger,
  makeEscalationContext,
  makeInProgressStory,
  makeLogger,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
} from "@test/helpers";
import { type TierConfig, TierConfigSchema } from "@/config";
import { isThreeSessionStrategy } from "@/config/test-strategy";
import {
  _tierEscalationDeps,
  type EscalationHandlerContext,
  handleTierEscalation,
  preIterationTierCheck,
  resolveMaxAttemptsOutcome,
} from "@/execution/escalation/tier-escalation";
import type { LoadedHooksConfig } from "@/hooks";
import type { StoryRouting, UserStory } from "@/prd";
import { resolveOperatingTier, resolveRouting } from "@/routing";
import type { NaxRuntime } from "@/runtime";
import type { DispatchContext } from "@/runtime/dispatch-context";
import type { FailureCategory } from "@/tdd/types";

describe("S5: greenfield-no-tests fallback", () => {
  /**
   * Simulates the escalation routing logic from runner.ts for the greenfield switch.
   * This mirrors the exact transform applied when greenfield-no-tests fires: any
   * three-session strategy is swapped to tdd-simple (single-session, test-first).
   */
  function applyGreenfieldFallbackRouting(
    story: UserStory,
    escalateFailureCategory: FailureCategory | undefined,
    nextTier: "fast" | "balanced" | "powerful",
  ): { routing: UserStory["routing"]; attempts: number } {
    const escalateRetryAsTddSimple = escalateFailureCategory === "greenfield-no-tests";
    const currentTestStrategy = story.routing?.testStrategy ?? "tdd-simple";
    const shouldSwitchToTddSimple = escalateRetryAsTddSimple && isThreeSessionStrategy(currentTestStrategy);

    const updatedRouting = story.routing
      ? {
          ...story.routing,
          modelTier: shouldSwitchToTddSimple ? story.routing.modelTier : nextTier,
          ...(shouldSwitchToTddSimple ? { testStrategy: "tdd-simple" as const } : {}),
        }
      : undefined;

    const shouldResetAttempts = shouldSwitchToTddSimple || story.routing?.modelTier !== nextTier;

    return {
      routing: updatedRouting,
      attempts: shouldResetAttempts ? 0 : (story.attempts ?? 0) + 1,
    };
  }

  describe("AC1: greenfield-no-tests switches to tdd-simple on first occurrence", () => {
    test("story on three-session-tdd switches to tdd-simple and resets attempts", () => {
      const story: UserStory = {
        id: "US-001",
        title: "Greenfield Story",
        description: "Story with no existing tests",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 2,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");

      expect(routing?.testStrategy).toBe("tdd-simple");
      expect(routing?.modelTier).toBe("fast"); // Tier stays the same
      expect(attempts).toBe(0); // Attempts reset on strategy switch
    });

    test("story on three-session-tdd-lite switches to tdd-simple", () => {
      const story: UserStory = {
        id: "US-002",
        title: "Lite TDD Story",
        description: "Story using lite mode",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 3,
        routing: {
          complexity: "complex",
          modelTier: "balanced",
          testStrategy: "three-session-tdd-lite",
          reasoning: "complex",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "powerful");

      expect(routing?.testStrategy).toBe("tdd-simple");
      expect(routing?.modelTier).toBe("balanced"); // Tier stays the same
      expect(attempts).toBe(0); // Attempts reset
    });
  });

  describe("AC2: greenfield-no-tests on test-after proceeds with normal escalation", () => {
    test("story already on test-after escalates tier normally", () => {
      const story: UserStory = {
        id: "US-003",
        title: "Test-after Story",
        description: "Story already using test-after",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 4,
        routing: {
          complexity: "simple",
          modelTier: "fast",
          testStrategy: "test-after",
          reasoning: "simple",
        },
      };

      const { routing, attempts } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");

      expect(routing?.testStrategy).toBe("test-after");
      expect(routing?.modelTier).toBe("balanced"); // Tier escalates
      expect(attempts).toBe(0); // Attempts reset on tier escalation
    });

    test("greenfield-no-tests fires twice on same story (second time escalates)", () => {
      let story: UserStory = {
        id: "US-004",
        title: "Double Greenfield",
        description: "Story that triggers greenfield twice",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 2,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      // First greenfield-no-tests: switch to tdd-simple
      let result = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");
      story = { ...story, attempts: result.attempts, routing: result.routing };

      expect(story.routing?.testStrategy).toBe("tdd-simple");
      expect(story.routing?.modelTier).toBe("fast");
      expect(story.attempts).toBe(0);

      // Second greenfield-no-tests: already single-session (tdd-simple), escalate tier
      result = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");
      story = { ...story, attempts: result.attempts, routing: result.routing };

      expect(story.routing?.testStrategy).toBe("tdd-simple"); // Stays tdd-simple
      expect(story.routing?.modelTier).toBe("balanced"); // Tier escalates
      expect(story.attempts).toBe(0); // Attempts reset on tier change
    });
  });

  describe("resolveMaxAttemptsOutcome for greenfield-no-tests", () => {
    test("greenfield-no-tests returns pause (requires human review)", () => {
      expect(resolveMaxAttemptsOutcome("greenfield-no-tests")).toBe("pause");
    });

    test("greenfield-no-tests pauses only when max attempts exhausted", () => {
      expect(resolveMaxAttemptsOutcome("greenfield-no-tests")).toBe("pause");
    });
  });

  describe("non-greenfield-no-tests categories behave normally", () => {
    test("isolation-violation does NOT trigger tdd-simple switch", () => {
      const story: UserStory = {
        id: "US-005",
        title: "Isolation Violation",
        description: "Story with isolation issue",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 2,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      const { routing } = applyGreenfieldFallbackRouting(story, "isolation-violation", "balanced");

      expect(routing?.testStrategy).toBe("three-session-tdd");
      expect(routing?.modelTier).toBe("balanced");
    });

    test("tests-failing does NOT trigger tdd-simple switch", () => {
      const story: UserStory = {
        id: "US-006",
        title: "Tests Failing",
        description: "Story with failing tests",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 3,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      const { routing } = applyGreenfieldFallbackRouting(story, "tests-failing", "balanced");

      expect(routing?.testStrategy).toBe("three-session-tdd");
      expect(routing?.modelTier).toBe("balanced");
    });
  });

  describe("edge cases", () => {
    test("story without routing field handles switch gracefully", () => {
      const story: UserStory = {
        id: "US-007",
        title: "No Routing",
        description: "Story without routing",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 1,
        routing: undefined,
      };

      const { routing } = applyGreenfieldFallbackRouting(story, "greenfield-no-tests", "balanced");

      expect(routing).toBeUndefined();
    });

    test("undefined failure category does NOT trigger tdd-simple switch", () => {
      const story: UserStory = {
        id: "US-008",
        title: "No Category",
        description: "Story with no failure category",
        acceptanceCriteria: ["AC1"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 2,
        routing: {
          complexity: "complex",
          modelTier: "fast",
          testStrategy: "three-session-tdd",
          reasoning: "complex",
        },
      };

      const { routing } = applyGreenfieldFallbackRouting(story, undefined, "balanced");

      expect(routing?.testStrategy).toBe("three-session-tdd");
      expect(routing?.modelTier).toBe("balanced");
    });
  });
});

// ---------------------------------------------------------------------------
// Shared scaffolding (#1575 first-iteration + #1710/#1745/#1761 reroute/deps)
// ---------------------------------------------------------------------------

/** A cross-agent ladder: no `pi@fast` rung exists, only `pi@balanced`. */
const CROSS_AGENT_LADDER: TierConfig[] = [
  { tier: "balanced", agent: "pi", attempts: 2 },
  { tier: "powerful", agent: "claude", attempts: 2 },
];

/**
 * A profile-assigned story carrying a stale tier ("fast") from an earlier write,
 * paired with the profile's agent — the exact shape that produced the #1575 warning.
 */
function makeProfileStory(attempts: number, routing: Partial<StoryRouting> = {}): UserStory {
  return makeInProgressStory({
    id: "US-1575",
    attempts,
    routing: {
      complexity: "medium",
      modelTier: "fast",
      profileModelTier: "balanced",
      agent: "pi",
      agentProfileId: "pi-balanced",
      testStrategy: "test-after",
      reasoning: "",
      ...routing,
    },
  });
}

function buildConfig(tierOrder: TierConfig[]) {
  return makeNaxConfig({
    models: {
      pi: { fast: "pi-fast", balanced: "pi-balanced", powerful: "pi-powerful" },
      claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
    },
    autoMode: { escalation: { enabled: true, tierOrder } },
  });
}

function asHooks(): LoadedHooksConfig {
  // Only read on the "no next tier" branch, which none of these cases reach.
  return { hooks: {} };
}

/** Captured logger, so a test can assert on the absence of a diagnostic. */
let logger: MockLogger;
let origSavePRD: typeof _tierEscalationDeps.savePRD;
let origGetSafeLogger: typeof _tierEscalationDeps.getSafeLogger;

beforeEach(() => {
  logger = makeLogger();
  origSavePRD = _tierEscalationDeps.savePRD;
  origGetSafeLogger = _tierEscalationDeps.getSafeLogger;
  // No-op persistence so the test never touches real disk.
  _tierEscalationDeps.savePRD = () => Promise.resolve();
  // Capture warnings for the logged-once contract.
  _tierEscalationDeps.getSafeLogger = () => logger;
});

afterEach(() => {
  _tierEscalationDeps.savePRD = origSavePRD;
  _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
});

async function runPreIter(story: UserStory, tierOrder: TierConfig[], previewTier = "balanced") {
  return await preIterationTierCheck(
    story,
    {
      complexity: "medium",
      modelTier: previewTier as "fast" | "balanced" | "powerful",
      testStrategy: "test-after",
      reasoning: "test",
    },
    buildConfig(tierOrder),
    makePRD({ userStories: [story] }),
    "/tmp/test-prd-1575.json",
    undefined,
    asHooks(),
    "f",
    0,
    "/tmp",
  );
}

const UNBOUNDED_WARN = "Current rung not found in tierOrder";

function unboundedWarnings(): LogCall[] {
  return logger.calls.filter((c) => c.level === "warn" && c.message.includes(UNBOUNDED_WARN));
}

function makeDispatchContext(runtime: NaxRuntime): DispatchContext {
  return {
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    runtime,
    abortSignal: runtime.signal,
  };
}

// ---------------------------------------------------------------------------
// #1575: the bug — false warning on a story's first iteration
// ---------------------------------------------------------------------------

describe("#1575: first iteration does not judge a pre-classification rung", () => {
  test("does not warn about an unbounded budget when attempts === 0 and the stale tier is off-ladder", async () => {
    const result = await runPreIter(makeProfileStory(0), CROSS_AGENT_LADDER);

    expect(unboundedWarnings()).toEqual([]);
    expect(result.shouldSkipIteration).toBe(false);
  });

  test("leaves the PRD untouched when attempts === 0", async () => {
    const story = makeProfileStory(0);
    const result = await runPreIter(story, CROSS_AGENT_LADDER);

    expect(result.prdDirty).toBe(false);
    const unchanged = result.prd.userStories.find((s) => s.id === story.id);
    expect(unchanged?.attempts).toBe(0);
    // The stale tier is neither acted on nor rewritten — the routing stage owns it.
    expect(unchanged?.routing?.modelTier).toBe("fast");
  });

  test("does not warn at attempts === 0 even when the ladder has no agent-qualified rungs", async () => {
    const result = await runPreIter(makeProfileStory(0), [{ tier: "balanced", attempts: 2 }]);

    expect(unboundedWarnings()).toEqual([]);
    expect(result.shouldSkipIteration).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1575: the diagnostic must survive where it is genuine
// ---------------------------------------------------------------------------

describe("#1575: the unbounded-budget warning still fires once the rung is authoritative", () => {
  test("warns when attempts > 0 and the story's rung is absent from tierOrder", async () => {
    // attempts > 0 means an iteration ran, so routing.ts has written and persisted
    // an authoritative modelTier — an off-ladder rung here is a real config gap.
    const story = makeProfileStory(1, { modelTier: "fast", profileModelTier: undefined });

    const result = await runPreIter(story, CROSS_AGENT_LADDER);

    expect(unboundedWarnings()).toHaveLength(1);
    expect(unboundedWarnings()[0]?.data).toMatchObject({ storyId: "US-1575", currentTier: "fast", agent: "pi" });
    expect(result.shouldSkipIteration).toBe(false);
  });

  test("still escalates a story that has exhausted its rung budget", async () => {
    const story = makeProfileStory(2, { modelTier: "balanced" });

    const result = await runPreIter(story, CROSS_AGENT_LADDER);

    expect(result.shouldSkipIteration).toBe(true);
    const escalated = result.prd.userStories.find((s) => s.id === story.id);
    expect(escalated?.routing?.modelTier).toBe("powerful");
    expect(escalated?.routing?.agent).toBe("claude");
    expect(escalated?.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #1575: the invariant the guard rests on
// ---------------------------------------------------------------------------

describe("#1575: tierOrder rungs always carry a non-zero attempt budget", () => {
  test("TierConfigSchema rejects attempts: 0, so `0 < tierCfg.attempts` always holds at attempts === 0", () => {
    expect(TierConfigSchema.safeParse({ tier: "fast", attempts: 0 }).success).toBe(false);
    expect(TierConfigSchema.safeParse({ tier: "fast", attempts: 1 }).success).toBe(true);
  });
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

// ---------------------------------------------------------------------------
// #1761 — routing-less story inherits complexity from the batch lead
// ---------------------------------------------------------------------------

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
