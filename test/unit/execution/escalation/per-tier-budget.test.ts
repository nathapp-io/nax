/**
 * US-003: Enforce per-tier attempt budgets before dispatch
 *
 * Acceptance criteria for the per-rung attempt-budget feature. Tests are
 * written before the implementation (Test-Writer / Lite) so they fail with
 * assertion failures, not compile errors, and the implementer wires up the
 * missing behaviour to turn them green.
 *
 *   AC-1: NaxConfigSchema.parse({}) yields tierOrder [fast, balanced, powerful]
 *         with attempts: 2 on every rung.
 *   AC-2: calculateMaxIterations(default ladder) === 6.
 *   AC-3: preIterationTierCheck returns shouldSkipIteration: false when
 *         story.attempts (1) < rung budget (2).
 *   AC-4: preIterationTierCheck returns shouldSkipIteration: true when
 *         story.attempts (2) === rung budget (2).
 *   AC-5: When shouldSkipIteration: true for an exhausted rung, the returned
 *         PRD advances that story's routing.modelTier to the next rung.
 *   AC-6: When shouldSkipIteration: true for an exhausted rung, the returned
 *         PRD resets that story's attempts to 0.
 *   AC-7: When the story's current tier is absent from tierOrder, returns
 *         shouldSkipIteration: false regardless of attempts.
 *   AC-8: When the story is at rung budget AND autoMode.escalation.enabled is
 *         false, returns shouldSkipIteration: false (budget exhaustion does not
 *         escalate).
 *   AC-12: Under the default ladder, a story that fails twice at "fast"
 *         reaches "balanced" (not "powerful").
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TierConfig } from "@/config";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config";
import { _tierEscalationDeps, calculateMaxIterations, preIterationTierCheck } from "@/execution/escalation";
import { makeNaxConfig } from "@test/helpers";

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

function makeInProgressStory(overrides: Record<string, unknown> = {}) {
  return {
    id: "US-003-ac",
    title: "Story",
    description: "Test",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress" as const,
    passes: false,
    escalations: [],
    attempts: 0,
    routing: { modelTier: "fast", testStrategy: "test-after" as const },
    ...overrides,
  };
}

function makePrd(stories: ReturnType<typeof makeInProgressStory>[]) {
  return {
    project: "test",
    feature: "f",
    branchName: "b",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function buildConfig(tierOrder: TierConfig[], enabled = true) {
  // Shared helper to keep the call sites short. We use makeNaxConfig from
  // test/helpers so we inherit DEFAULT_CONFIG for every other field —
  // a hand-rolled `{ autoMode: ..., routing: ..., models: {} }` block would
  // trip check-inline-test-mocks and silently drift from real defaults.
  return makeNaxConfig({
    autoMode: {
      escalation: {
        enabled,
        tierOrder,
      },
    },
  });
}

/** Cast a partial story to the full UserStory shape that preIterationTierCheck
 *  expects. The function signature uses Parameters<...>[N] to stay in sync
 *  with the source — if a parameter type changes, this helper surfaces the
 *  mismatch at the call site. */
function asStory(s: ReturnType<typeof makeInProgressStory>) {
  return s as unknown as Parameters<typeof preIterationTierCheck>[0]; // test-ratchet-allow: as-unknown-as
}

function asConfig(c: ReturnType<typeof buildConfig>) {
  return c as unknown as Parameters<typeof preIterationTierCheck>[2]; // test-ratchet-allow: as-unknown-as
}

function asPrd(p: ReturnType<typeof makePrd>) {
  return p as unknown as Parameters<typeof preIterationTierCheck>[3]; // test-ratchet-allow: as-unknown-as
}

function asHooks() {
  // The function only reads hooks via fireHook for the "no next tier" branch
  // (AC-8 path). All our AC-3/4/5/6/7 tests never reach it; AC-8 hits the
  // disabled-escalation branch instead. Either way, an empty hooks object
  // is the right value.
  return { hooks: {} } as unknown as Parameters<typeof preIterationTierCheck>[6]; // test-ratchet-allow: as-unknown-as
}

/** Run preIterationTierCheck with the standard test fixture shape, so each
 *  AC test reads as a single observable assertion instead of four cast
 *  preludes. */
async function runPreIter(
  story: ReturnType<typeof makeInProgressStory>,
  config: ReturnType<typeof buildConfig>,
  prd: ReturnType<typeof makePrd>,
  prdPath: string,
) {
  return await preIterationTierCheck(
    asStory(story),
    { modelTier: story.routing.modelTier },
    asConfig(config),
    asPrd(prd),
    prdPath,
    undefined,
    asHooks(),
    "f",
    0,
    "/tmp",
  );
}

let origSavePRD: typeof _tierEscalationDeps.savePRD;

beforeEach(() => {
  origSavePRD = _tierEscalationDeps.savePRD;
  // No-op persistence so the test never touches real disk.
  _tierEscalationDeps.savePRD = () => Promise.resolve();
});

afterEach(() => {
  _tierEscalationDeps.savePRD = origSavePRD;
});

// ---------------------------------------------------------------------------
// AC-1: Schema defaults — ladder is [fast, balanced, powerful] each attempts:2
// ---------------------------------------------------------------------------

describe("US-003 AC-1: NaxConfigSchema defaults ship the 2/2/2 ladder", () => {
  test("NaxConfigSchema.parse({}).autoMode.escalation.tierOrder is [fast, balanced, powerful] with attempts: 2 on every rung", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.autoMode.escalation.tierOrder).toEqual([
      { tier: "fast", attempts: 2 },
      { tier: "balanced", attempts: 2 },
      { tier: "powerful", attempts: 2 },
    ]);
  });

  test("DEFAULT_CONFIG carries the same 2/2/2 ladder (no hand-maintained literal divergence)", () => {
    expect(DEFAULT_CONFIG.autoMode.escalation.tierOrder).toEqual([
      { tier: "fast", attempts: 2 },
      { tier: "balanced", attempts: 2 },
      { tier: "powerful", attempts: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-2: calculateMaxIterations(default ladder) === 6
// ---------------------------------------------------------------------------

describe("US-003 AC-2: calculateMaxIterations on the shipped ladder", () => {
  test("returns 6 when given the actual DEFAULT_CONFIG.escalation.tierOrder", () => {
    expect(calculateMaxIterations(DEFAULT_CONFIG.autoMode.escalation.tierOrder)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// AC-3 / AC-4: preIterationTierCheck — story within vs at budget
// ---------------------------------------------------------------------------

describe("US-003 AC-3: preIterationTierCheck — story within rung budget", () => {
  test("returns shouldSkipIteration: false when attempts (1) < rung budget (2)", async () => {
    const story = makeInProgressStory({ attempts: 1, routing: { modelTier: "fast", testStrategy: "test-after" } });
    const prd = makePrd([story]);
    const config = buildConfig([
      { tier: "fast", attempts: 2 },
      { tier: "balanced", attempts: 2 },
    ]);

    const result = await runPreIter(story, config, prd, "/tmp/test-prd-ac3.json");

    expect(result.shouldSkipIteration).toBe(false);
  });
});

describe("US-003 AC-4: preIterationTierCheck — story at rung budget", () => {
  test("returns shouldSkipIteration: true when attempts (2) === rung budget (2)", async () => {
    const story = makeInProgressStory({ attempts: 2, routing: { modelTier: "fast", testStrategy: "test-after" } });
    const prd = makePrd([story]);
    const config = buildConfig([
      { tier: "fast", attempts: 2 },
      { tier: "balanced", attempts: 2 },
    ]);

    const result = await runPreIter(story, config, prd, "/tmp/test-prd-ac4.json");

    expect(result.shouldSkipIteration).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6: returned PRD state on escalation
// ---------------------------------------------------------------------------

describe("US-003 AC-5: preIterationTierCheck — returned PRD advances modelTier on escalation", () => {
  test("result.prd advances story.routing.modelTier to the next rung (fast → balanced)", async () => {
    const story = makeInProgressStory({ attempts: 2, routing: { modelTier: "fast", testStrategy: "test-after" } });
    const prd = makePrd([story]);
    const config = buildConfig([
      { tier: "fast", attempts: 2 },
      { tier: "balanced", attempts: 2 },
    ]);

    const result = await runPreIter(story, config, prd, "/tmp/test-prd-ac5.json");

    expect(result.shouldSkipIteration).toBe(true);
    const advanced = result.prd.userStories.find((s) => s.id === story.id);
    expect(advanced).toBeDefined();
    expect(advanced?.routing?.modelTier).toBe("balanced");
  });
});

describe("US-003 AC-6: preIterationTierCheck — returned PRD resets attempts on escalation", () => {
  test("result.prd resets story.attempts to 0 on escalation", async () => {
    const story = makeInProgressStory({ attempts: 2, routing: { modelTier: "fast", testStrategy: "test-after" } });
    const prd = makePrd([story]);
    const config = buildConfig([
      { tier: "fast", attempts: 2 },
      { tier: "balanced", attempts: 2 },
    ]);

    const result = await runPreIter(story, config, prd, "/tmp/test-prd-ac6.json");

    expect(result.shouldSkipIteration).toBe(true);
    const reset = result.prd.userStories.find((s) => s.id === story.id);
    expect(reset).toBeDefined();
    expect(reset?.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-7: story's current tier absent from tierOrder
// ---------------------------------------------------------------------------

describe("US-003 AC-7: preIterationTierCheck — story's current tier is absent from tierOrder", () => {
  test("returns shouldSkipIteration: false when attempts (100) far exceeds any budget and current tier is absent from tierOrder", async () => {
    // Story is routed at "fast" but the only ladder rung is "balanced" — unmatched rung.
    const story = makeInProgressStory({
      attempts: 100,
      routing: { modelTier: "fast", testStrategy: "test-after" },
    });
    const prd = makePrd([story]);
    const config = buildConfig([{ tier: "balanced", attempts: 2 }]);

    const result = await runPreIter(story, config, prd, "/tmp/test-prd-ac7.json");

    // Budget is unbounded for the unmatched rung → iteration proceeds.
    expect(result.shouldSkipIteration).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-8: escalation disabled at rung budget → proceed
// ---------------------------------------------------------------------------

describe("US-003 AC-8: preIterationTierCheck — escalation disabled at rung budget", () => {
  test("returns shouldSkipIteration: false at budget (attempts === rung budget) when autoMode.escalation.enabled is false", async () => {
    const story = makeInProgressStory({ attempts: 2, routing: { modelTier: "fast", testStrategy: "test-after" } });
    const prd = makePrd([story]);
    // enabled=false → budget exhaustion must not escalate; the iteration proceeds.
    const config = buildConfig(
      [
        { tier: "fast", attempts: 2 },
        { tier: "balanced", attempts: 2 },
      ],
      false,
    );

    const result = await runPreIter(story, config, prd, "/tmp/test-prd-ac8.json");

    expect(result.shouldSkipIteration).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-12: full chain — default ladder, story fails twice at fast reaches balanced
// ---------------------------------------------------------------------------

describe("US-003 AC-12: full chain — story fails twice at fast reaches balanced (not powerful)", () => {
  test("default ladder, attempts=2 at fast, returned PRD has modelTier=balanced (not powerful)", async () => {
    const story = makeInProgressStory({ attempts: 2, routing: { modelTier: "fast", testStrategy: "test-after" } });
    const prd = makePrd([story]);
    // Use the actual default ladder shipped by NaxConfigSchema — proves AC-12 works
    // against the real SSOT defaults, not a hand-copied mirror.
    const config = buildConfig(DEFAULT_CONFIG.autoMode.escalation.tierOrder);

    const result = await runPreIter(story, config, prd, "/tmp/test-prd-ac12.json");

    expect(result.shouldSkipIteration).toBe(true);
    const advanced = result.prd.userStories.find((s) => s.id === story.id);
    expect(advanced).toBeDefined();
    // The first rung after fast is balanced — must NOT skip straight to powerful.
    expect(advanced?.routing?.modelTier).toBe("balanced");
    expect(advanced?.routing?.modelTier).not.toBe("powerful");
    // Attempt counter was reset to 0 for the new rung.
    expect(advanced?.attempts).toBe(0);
  });
});
