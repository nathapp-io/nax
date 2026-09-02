/**
 * Spec §7: off-ladder start = fixed rung, no escalation.
 *
 * A story whose rung is absent from `tierOrder` (persisted PRD state routed
 * under an older or different config) is pinned by contract: it runs on that
 * rung, exhausts attempts, is never escalated, and logs exactly one
 * "escalation budget is unbounded" warning. The `attempts === 0` early return
 * (#1575) fires before any rung judgement and must survive refactors — this
 * file pins it as a test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeInProgressStory, makeLogger, makeNaxConfig } from "@test/helpers";
import type { NaxConfig, TierConfig } from "@/config";
import { _tierEscalationDeps, preIterationTierCheck } from "@/execution/escalation";
import type { PRD, UserStory } from "@/prd";

// ---------------------------------------------------------------------------
// Shared scaffolding (mirrors per-tier-budget.test.ts)
// ---------------------------------------------------------------------------

/** A native-only ladder — "powerful"/"claude" is off it by construction. */
const CUSTOM_LADDER: TierConfig[] = [
  { tier: "cheap", agent: "native", attempts: 2 },
  { tier: "balanced", agent: "native", attempts: 2 },
];

/** The off-ladder story: claude/powerful, a rung the native ladder never names. */
function offLadderStory(attempts: number): UserStory {
  return makeInProgressStory({
    id: "US-005-offladder",
    attempts,
    routing: {
      complexity: "complex",
      modelTier: "powerful",
      agent: "claude",
      testStrategy: "test-after",
      reasoning: "",
    },
  });
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test",
    feature: "f",
    branchName: "b",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function buildConfig(tierOrder: TierConfig[]): NaxConfig {
  return makeNaxConfig({
    autoMode: {
      escalation: {
        enabled: true,
        tierOrder,
      },
    },
  });
}

/** Run preIterationTierCheck with the standard fixture shape (same as per-tier-budget). */
async function runPreIter(story: UserStory, config: NaxConfig, prd: PRD) {
  return await preIterationTierCheck(
    story,
    {
      complexity: "medium",
      modelTier: story.routing?.modelTier ?? "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    config,
    prd,
    "/tmp/test-prd-offladder.json",
    undefined,
    // Only read on the "no next tier" branch; an off-ladder rung never reaches it.
    { hooks: {} },
    "f",
    0,
    "/tmp",
  );
}

let origSavePRD: typeof _tierEscalationDeps.savePRD;
let origGetSafeLogger: typeof _tierEscalationDeps.getSafeLogger;
let logger: ReturnType<typeof makeLogger>;

beforeEach(() => {
  origSavePRD = _tierEscalationDeps.savePRD;
  origGetSafeLogger = _tierEscalationDeps.getSafeLogger;
  // No-op persistence so the test never touches real disk.
  _tierEscalationDeps.savePRD = () => Promise.resolve();
  // Capture warnings for the logged-once contract.
  logger = makeLogger();
  _tierEscalationDeps.getSafeLogger = () => logger;
});

afterEach(() => {
  _tierEscalationDeps.savePRD = origSavePRD;
  _tierEscalationDeps.getSafeLogger = origGetSafeLogger;
});

// ---------------------------------------------------------------------------
// §7: off-ladder start = fixed rung, no escalation
// ---------------------------------------------------------------------------

describe("off-ladder start = fixed rung, no escalation (spec §7)", () => {
  test("off-ladder rung: budget-unbounded warning, never escalates", async () => {
    // config.autoMode.escalation.tierOrder = CUSTOM_LADDER (native-only rungs);
    // story.routing = { modelTier: "powerful", agent: "claude", ... }, attempts
    // well past any budget.
    const story = offLadderStory(100);
    const prd = makePrd([story]);
    const config = buildConfig(CUSTOM_LADDER);

    const result = await runPreIter(story, config, prd);

    // Budget is unbounded for the unmatched rung → the iteration proceeds.
    expect(result.shouldSkipIteration).toBe(false);
    // No escalation happened: the PRD was not dirtied (same reference, no record).
    expect(result.prdDirty).toBe(false);
    expect(result.prd).toBe(prd);
    const persisted = result.prd.userStories.find((s) => s.id === story.id);
    expect(persisted?.escalations).toHaveLength(0);
    expect(persisted?.attempts).toBe(100);
    expect(persisted?.routing?.modelTier).toBe("powerful");
    // The story object itself was not touched.
    expect(story.escalations).toHaveLength(0);

    // Exactly one unbounded-budget warning — the §7 logging contract.
    const unboundedWarns = logger.calls.filter(
      (c) => c.level === "warn" && c.message.includes("escalation budget is unbounded"),
    );
    expect(unboundedWarns).toHaveLength(1);
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(1);
  });

  test("attempts === 0 short-circuits before any rung judgement (#1575 guard)", async () => {
    // Same off-ladder story with attempts: 0 → returns { shouldSkipIteration: false, prdDirty: false }
    // without logging the unbounded warning (the early return fires first).
    const story = offLadderStory(0);
    const prd = makePrd([story]);
    const config = buildConfig(CUSTOM_LADDER);

    const result = await runPreIter(story, config, prd);

    expect(result.shouldSkipIteration).toBe(false);
    expect(result.prdDirty).toBe(false);
    expect(result.prd).toBe(prd);
    expect(story.escalations).toHaveLength(0);

    // The early return fires before the rung lookup — no unbounded warning, no warn at all.
    expect(logger.calls.filter((c) => c.level === "warn")).toHaveLength(0);
  });
});
