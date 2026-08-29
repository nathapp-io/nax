/**
 * Issue #1575: preIterationTierCheck must not judge a story's rung before that
 * story's routing stage has run.
 *
 * On a first iteration `story.routing.modelTier` is stale by construction — the
 * per-iteration routing stage (src/pipeline/stages/routing.ts) is the writer, and
 * it runs strictly AFTER this check. Under a cross-agent profile ladder the check
 * therefore pairs the profile's agent with a non-profile tier, producing a rung
 * that is absent from tierOrder and a false "escalation budget is unbounded"
 * WARN on the story's very first attempt.
 *
 * The guard is safe because every tierOrder rung has attempts >= 1
 * (TierConfigSchema, src/config/schemas-model.ts) — so at attempts === 0 the
 * budget comparison `0 < tierCfg.attempts` always holds and the check can never
 * skip, escalate, or dirty the PRD. Pinned by the schema test at the bottom.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LogCall, type MockLogger, makeInProgressStory, makeLogger, makeNaxConfig, makePRD } from "@test/helpers";
import type { TierConfig } from "@/config";
import { TierConfigSchema } from "@/config";
import { _tierEscalationDeps, preIterationTierCheck } from "@/execution/escalation";
import type { LoadedHooksConfig } from "@/hooks";
import type { StoryRouting, UserStory } from "@/prd";

// ---------------------------------------------------------------------------
// Scaffolding
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

// ---------------------------------------------------------------------------
// The bug: false warning on a story's first iteration
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
// The diagnostic must survive where it is genuine
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
// The invariant the guard rests on
// ---------------------------------------------------------------------------

describe("#1575: tierOrder rungs always carry a non-zero attempt budget", () => {
  test("TierConfigSchema rejects attempts: 0, so `0 < tierCfg.attempts` always holds at attempts === 0", () => {
    expect(TierConfigSchema.safeParse({ tier: "fast", attempts: 0 }).success).toBe(false);
    expect(TierConfigSchema.safeParse({ tier: "fast", attempts: 1 }).success).toBe(true);
  });
});
