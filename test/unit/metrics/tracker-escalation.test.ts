/**
 * Metrics Tracker — Escalation Metrics Preservation (BUG-067)
 *
 * RED tests covering the three broken metrics when a story escalates:
 *
 * (1) cost — collectStoryMetrics must return the TOTAL cost across all attempts
 *     (including failed haiku/fast attempt), not just the final successful one.
 *
 * (2) attempts — the attempt counter must NOT appear to reset to 1 when a new
 *     tier succeeds. If haiku ran once (failed) and sonnet ran once (succeeded),
 *     storyMetrics.attempts must be 2.
 *
 * (3) firstPassSuccess — must be false when any prior attempt failed (even if
 *     story.escalations is empty, which handleTierEscalation never populates).
 *
 * Also covers handleTierEscalation recording enough data for the fix to work:
 * the escalated story must carry prior attempt info so the tracker can reconstruct
 * total cross-tier attempt counts.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import {
  _tierEscalationDeps,
  handleTierEscalation,
} from "../../../src/execution/escalation/tier-escalation";
import { collectStoryMetrics } from "../../../src/metrics/tracker";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd";
import type { StoryRouting } from "../../../src/prd/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test description",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 0,
    priorErrors: [],
    priorFailures: [],
    ...overrides,
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeConfig(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    autoMode: {
      ...DEFAULT_CONFIG.autoMode,
      escalation: {
        enabled: true,
        tierOrder: [
          { tier: "fast", attempts: 1 },
          { tier: "balanced", attempts: 3 },
          { tier: "powerful", attempts: 2 },
        ],
        escalateEntireBatch: false,
      },
    },
  } as NaxConfig;
}

/** Build a minimal PipelineContext. Cast lets overrides include future fix fields. */
function makeCtx(story: UserStory, overrides: Record<string, unknown> = {}): PipelineContext {
  return {
    config: makeConfig(),
    prd: makePRD([story]),
    story,
    stories: [story],
    routing: {
      complexity: "medium",
      modelTier: "balanced",
      testStrategy: "test-after",
      reasoning: "test",
    },
    workdir: "/tmp/nax-escalation-test",
    hooks: { hooks: {} },
    agentResult: {
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      estimatedCost: 0.10,
      durationMs: 5000,
    },
    ...overrides,
  } as unknown as PipelineContext;
}

// ---------------------------------------------------------------------------
// (3) firstPassSuccess — must be false when prior attempts failed
//
// Bug: handleTierEscalation never sets story.escalations[], so escalationCount
// is always 0, making firstPassSuccess incorrectly true after escalation.
//
// Fix: collectStoryMetrics should also check story.priorFailures to detect
// that a prior attempt occurred before declaring firstPassSuccess.
// ---------------------------------------------------------------------------

describe("collectStoryMetrics — firstPassSuccess with escalation (BUG-067)", () => {
  test("firstPassSuccess is false when story has priorFailures from haiku escalation", () => {
    // Simulate: haiku ran, failed, escalated to sonnet.
    // handleTierEscalation does NOT populate story.escalations[].
    // It only appends to story.priorFailures[].
    const story = makeStory({
      attempts: 0, // reset to 0 by handleTierEscalation on escalation
      escalations: [], // never populated by handleTierEscalation — this is the trap
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed with tier fast, escalating to next tier",
          timestamp: new Date().toISOString(),
        },
      ],
      routing: {
        complexity: "medium",
        testStrategy: "test-after",
        reasoning: "test",
        modelTier: "balanced",
      } satisfies StoryRouting,
    });

    const ctx = makeCtx(story, {
      routing: {
        complexity: "medium",
        modelTier: "balanced",
        testStrategy: "test-after",
        reasoning: "escalated to balanced after fast failure",
      },
      agentResult: {
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        estimatedCost: 0.10,
        durationMs: 5000,
      },
    });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    // RED: current implementation returns true because escalationCount === 0
    // (story.escalations is empty — handleTierEscalation never populates it)
    expect(metrics.firstPassSuccess).toBe(false);
  });

  test("firstPassSuccess is true when no prior failures and no escalations", () => {
    // Regression guard: first-pass success case must still work
    const story = makeStory({
      attempts: 1,
      escalations: [],
      priorFailures: [],
    });

    const ctx = makeCtx(story, {
      agentResult: {
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        estimatedCost: 0.05,
        durationMs: 3000,
      },
    });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    // This must keep working after the fix
    expect(metrics.firstPassSuccess).toBe(true);
  });

  test("firstPassSuccess is false when story has both priorFailures and escalations", () => {
    // Belt-and-suspenders: even when escalations IS populated, priorFailures also guards
    const story = makeStory({
      attempts: 0,
      escalations: [
        {
          fromTier: "fast",
          toTier: "balanced",
          reason: "exceeded tier budget",
          timestamp: new Date().toISOString(),
        },
      ],
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed with tier fast",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const ctx = makeCtx(story);
    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.firstPassSuccess).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (2) attempts — must count all cross-tier attempts, not just current tier
//
// Bug: handleTierEscalation resets story.attempts = 0 on tier change.
// collectStoryMetrics then reads Math.max(1, story.attempts || 1) = 1.
// Total should be: priorFailures.length + story.attempts + 1 (current).
// ---------------------------------------------------------------------------

describe("collectStoryMetrics — attempt count with escalation (BUG-067)", () => {
  test("reports 2 attempts when haiku failed once and sonnet succeeded once", () => {
    // After escalation: story.attempts reset to 0, priorFailures has 1 entry.
    // During sonnet execution: story.attempts is still 0 in the PRD.
    // Total cross-tier attempts = 1 (prior failure) + 1 (current attempt) = 2.
    const story = makeStory({
      attempts: 0, // reset to 0 by handleTierEscalation
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed with tier fast",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const ctx = makeCtx(story);
    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    // RED: current implementation returns Math.max(1, 0 || 1) = 1
    expect(metrics.attempts).toBe(2);
  });

  test("reports 3 attempts when haiku failed twice and sonnet succeeded once", () => {
    // Haiku tier has 2 attempt budget; both failed before escalating.
    const story = makeStory({
      attempts: 0,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed attempt 1",
          timestamp: new Date().toISOString(),
        },
        {
          attempt: 2,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed attempt 2",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const ctx = makeCtx(story);
    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    // RED: current returns 1; expected is 3
    expect(metrics.attempts).toBe(3);
  });

  test("reports 1 attempt when no prior failures (no escalation)", () => {
    // Regression guard: normal first-pass story must still report 1
    const story = makeStory({
      attempts: 1,
      priorFailures: [],
    });

    const ctx = makeCtx(story);
    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.attempts).toBe(1);
  });

  test("reports correct attempts when story.attempts is 1 within new tier", () => {
    // Story escalated from fast (1 failure), then sonnet ran once (attempts=1 in new tier)
    const story = makeStory({
      attempts: 1,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed at fast",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const ctx = makeCtx(story);
    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    // 1 prior failure + 1 current tier attempt = 2 total
    expect(metrics.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (1) cost — must sum across all attempts, including failed ones
//
// Bug: collectStoryMetrics uses only agentResult.estimatedCost (the final
// successful attempt). Prior attempt costs from failed escalations are lost.
//
// Fix: The runner/escalation handler must persist prior attempt costs so
// collectStoryMetrics can include them. The anticipated mechanism is a new
// `accumulatedAttemptCost` field on PipelineContext that the runner sets
// when an escalation iteration produces a cost delta.
// ---------------------------------------------------------------------------

describe("collectStoryMetrics — cost accumulation across escalations (BUG-067)", () => {
  test("cost includes prior attempt cost when story escalated (haiku cost + sonnet cost)", () => {
    // Haiku (fast tier) attempt cost: $0.05 — happened in a prior iteration
    // Sonnet (balanced tier) attempt cost: $0.10 — the current agentResult
    // Expected total story cost: $0.15
    const PRIOR_ATTEMPT_COST = 0.05;
    const CURRENT_ATTEMPT_COST = 0.10;

    const story = makeStory({
      attempts: 0,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed at fast tier",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    // accumulatedAttemptCost: not yet on PipelineContext — the fix must add it.
    // Cast to unknown first so TypeScript doesn't block the RED test.
    const ctx = makeCtx(story, {
      agentResult: {
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        estimatedCost: CURRENT_ATTEMPT_COST,
        durationMs: 5000,
      },
      accumulatedAttemptCost: PRIOR_ATTEMPT_COST,
    });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    // RED: current implementation returns only 0.10 (ignores accumulatedAttemptCost)
    expect(metrics.cost).toBeCloseTo(PRIOR_ATTEMPT_COST + CURRENT_ATTEMPT_COST, 5);
  });

  test("cost is just agentResult.estimatedCost when no prior attempts (no escalation)", () => {
    // Regression guard: unescalated stories must still report correctly
    const story = makeStory({ attempts: 1, priorFailures: [] });

    const ctx = makeCtx(story, {
      agentResult: {
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        estimatedCost: 0.05,
        durationMs: 3000,
      },
    });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.cost).toBeCloseTo(0.05, 5);
  });

  test("cost sums across multiple tier escalations (fast + balanced + powerful)", () => {
    // Story escalated twice: fast ($0.02) → balanced ($0.08) → powerful ($0.20, success)
    const FAST_COST = 0.02;
    const BALANCED_COST = 0.08;
    const POWERFUL_COST = 0.20;

    const story = makeStory({
      attempts: 0,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed at fast",
          timestamp: new Date().toISOString(),
        },
        {
          attempt: 2,
          modelTier: "balanced",
          stage: "escalation",
          summary: "Failed at balanced",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const ctx = makeCtx(story, {
      routing: {
        complexity: "expert",
        modelTier: "powerful",
        testStrategy: "three-session-tdd",
        reasoning: "escalated twice",
      },
      agentResult: {
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        estimatedCost: POWERFUL_COST,
        durationMs: 30000,
      },
      accumulatedAttemptCost: FAST_COST + BALANCED_COST,
    });

    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    // RED: returns only 0.20; expected 0.30
    expect(metrics.cost).toBeCloseTo(FAST_COST + BALANCED_COST + POWERFUL_COST, 5);
  });
});

// ---------------------------------------------------------------------------
// handleTierEscalation — preserves attempt info for BUG-067 fix
//
// After escalation, the escalated story must have priorFailures populated so
// collectStoryMetrics can reconstruct the total cross-tier attempt count.
// ---------------------------------------------------------------------------

describe("handleTierEscalation — priorFailures records attempt data (BUG-067)", () => {
  let origSavePRD: typeof _tierEscalationDeps.savePRD;

  afterEach(() => {
    if (origSavePRD) {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test("escalated story has priorFailures entry identifying the failed tier", async () => {
    origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({
      attempts: 1, // had 1 attempt at fast tier before escalation
      priorFailures: [],
    });

    const ctx = {
      story,
      storiesToExecute: [story],
      isBatchExecution: false,
      routing: { modelTier: "fast", testStrategy: "test-after" },
      pipelineResult: {
        reason: "Tests failing",
        context: {
          tddFailureCategory: undefined,
          retryAsLite: false,
          reviewFindings: undefined,
        },
      },
      config: makeConfig(),
      prd: makePRD([story]),
      prdPath: "/tmp/prd.json",
      featureDir: undefined,
      hooks: { hooks: {} },
      feature: "test-feature",
      totalCost: 0,
      workdir: "/tmp",
    };

    const result = await handleTierEscalation(
      ctx as Parameters<typeof handleTierEscalation>[0],
    );

    const updatedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(updatedStory).toBeDefined();

    // priorFailures must record the attempt that failed before escalation
    expect(updatedStory!.priorFailures).toBeDefined();
    expect(updatedStory!.priorFailures!.length).toBeGreaterThanOrEqual(1);

    // The failure record must identify the tier that ran
    expect(updatedStory!.priorFailures![0].modelTier).toBe("fast");
  });

  test("escalated story has attempts reset to 0 (BUG-011 preserved)", async () => {
    origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({ attempts: 1, priorFailures: [] });

    const ctx = {
      story,
      storiesToExecute: [story],
      isBatchExecution: false,
      routing: { modelTier: "fast", testStrategy: "test-after" },
      pipelineResult: {
        reason: "Tests failing",
        context: { tddFailureCategory: undefined, retryAsLite: false, reviewFindings: undefined },
      },
      config: makeConfig(),
      prd: makePRD([story]),
      prdPath: "/tmp/prd.json",
      featureDir: undefined,
      hooks: { hooks: {} },
      feature: "test-feature",
      totalCost: 0,
      workdir: "/tmp",
    };

    const result = await handleTierEscalation(
      ctx as Parameters<typeof handleTierEscalation>[0],
    );

    const updatedStory = result.prd.userStories.find((s) => s.id === "US-001");
    // BUG-011: attempts resets to 0 on tier change (this is intentional for per-tier budgeting)
    expect(updatedStory!.attempts).toBe(0);
  });

  test("escalated story modelTier is updated to next tier (regression guard)", async () => {
    origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = mock(() => Promise.resolve());

    const story = makeStory({
      attempts: 1,
      priorFailures: [],
      routing: {
        complexity: "medium",
        testStrategy: "test-after",
        reasoning: "test",
        modelTier: "fast",
      } satisfies StoryRouting,
    });

    const ctx = {
      story,
      storiesToExecute: [story],
      isBatchExecution: false,
      routing: { modelTier: "fast", testStrategy: "test-after" },
      pipelineResult: {
        reason: "Tests failing",
        context: { tddFailureCategory: undefined, retryAsLite: false, reviewFindings: undefined },
      },
      config: makeConfig(),
      prd: makePRD([story]),
      prdPath: "/tmp/prd.json",
      featureDir: undefined,
      hooks: { hooks: {} },
      feature: "test-feature",
      totalCost: 0,
      workdir: "/tmp",
    };

    const result = await handleTierEscalation(
      ctx as Parameters<typeof handleTierEscalation>[0],
    );

    const updatedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(updatedStory!.routing?.modelTier).toBe("balanced");
  });
});
