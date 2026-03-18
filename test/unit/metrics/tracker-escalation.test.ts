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
import { randomUUID } from "node:crypto";
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

const WORKDIR = `/tmp/nax-escalation-test-${randomUUID()}`;
const PRD_PATH = `/tmp/prd-${randomUUID()}.json`;

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
    workdir: WORKDIR,
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

// BUG-067
describe("collectStoryMetrics — firstPassSuccess is false when escalation occurs", () => {
  test.each([
    {
      name: "firstPassSuccess is false when story has priorFailures from haiku escalation",
      attempts: 0,
      hasPriorFailures: true,
      hasEscalations: false,
      expectedFirstPassSuccess: false,
    },
    {
      name: "firstPassSuccess is true when no prior failures and no escalations",
      attempts: 1,
      hasPriorFailures: false,
      hasEscalations: false,
      expectedFirstPassSuccess: true,
    },
    {
      name: "firstPassSuccess is false when story has both priorFailures and escalations",
      attempts: 0,
      hasPriorFailures: true,
      hasEscalations: true,
      expectedFirstPassSuccess: false,
    },
  ])(
    "$name",
    ({
      attempts,
      hasPriorFailures,
      hasEscalations,
      expectedFirstPassSuccess,
    }) => {
      const story = makeStory({
        attempts,
        escalations: hasEscalations
          ? [
              {
                fromTier: "fast",
                toTier: "balanced",
                reason: "exceeded tier budget",
                timestamp: new Date().toISOString(),
              },
            ]
          : [],
        priorFailures: hasPriorFailures
          ? [
              {
                attempt: 1,
                modelTier: "fast",
                stage: "escalation",
                summary: hasPriorFailures ? "Failed with tier fast" : "",
                timestamp: new Date().toISOString(),
              },
            ]
          : [],
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
          estimatedCost: 0.05,
          durationMs: 3000,
        },
      });

      const metrics = collectStoryMetrics(ctx, new Date().toISOString());
      expect(metrics.firstPassSuccess).toBe(expectedFirstPassSuccess);
    },
  );
});

// ---------------------------------------------------------------------------
// (2) attempts — must count all cross-tier attempts, not just current tier
//
// Bug: handleTierEscalation resets story.attempts = 0 on tier change.
// collectStoryMetrics then reads Math.max(1, story.attempts || 1) = 1.
// Total should be: priorFailures.length + story.attempts + 1 (current).
// ---------------------------------------------------------------------------

// BUG-067
describe("collectStoryMetrics — attempt count includes all cross-tier attempts", () => {
  test.each([
    {
      name: "reports 2 attempts when haiku failed once and sonnet succeeded once",
      attempts: 0,
      priorFailuresCount: 1,
      expectedAttempts: 2,
    },
    {
      name: "reports 3 attempts when haiku failed twice and sonnet succeeded once",
      attempts: 0,
      priorFailuresCount: 2,
      expectedAttempts: 3,
    },
    {
      name: "reports 1 attempt when no prior failures (no escalation)",
      attempts: 1,
      priorFailuresCount: 0,
      expectedAttempts: 1,
    },
    {
      name: "reports correct attempts when story.attempts is 1 within new tier",
      attempts: 1,
      priorFailuresCount: 1,
      expectedAttempts: 2,
    },
  ])("$name", ({ attempts, priorFailuresCount, expectedAttempts }) => {
    const priorFailures = Array.from({ length: priorFailuresCount }, (_, i) => ({
      attempt: i + 1,
      modelTier: "fast" as const,
      stage: "escalation" as const,
      summary: priorFailuresCount > 1 ? `Failed attempt ${i + 1}` : "Failed with tier fast",
      timestamp: new Date().toISOString(),
    }));

    const story = makeStory({
      attempts,
      priorFailures,
    });

    const ctx = makeCtx(story);
    const metrics = collectStoryMetrics(ctx, new Date().toISOString());

    expect(metrics.attempts).toBe(expectedAttempts);
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

// BUG-067
describe("collectStoryMetrics — cost accumulates across all tier escalations", () => {
  test.each([
    {
      name: "cost includes prior attempt cost when story escalated (haiku cost + sonnet cost)",
      priorFailuresCount: 1,
      priorAttemptCost: 0.05,
      currentAttemptCost: 0.10,
      expectedCost: 0.15,
    },
    {
      name: "cost is just agentResult.estimatedCost when no prior attempts (no escalation)",
      priorFailuresCount: 0,
      priorAttemptCost: 0,
      currentAttemptCost: 0.05,
      expectedCost: 0.05,
    },
    {
      name: "cost sums across multiple tier escalations (fast + balanced + powerful)",
      priorFailuresCount: 2,
      priorAttemptCost: 0.1, // 0.02 + 0.08
      currentAttemptCost: 0.2,
      expectedCost: 0.3,
    },
  ])(
    "$name",
    ({
      priorFailuresCount,
      priorAttemptCost,
      currentAttemptCost,
      expectedCost,
    }) => {
      const priorFailures = Array.from({ length: priorFailuresCount }, (_, i) => ({
        attempt: i + 1,
        modelTier: i === 0 ? ("fast" as const) : ("balanced" as const),
        stage: "escalation" as const,
        summary: priorFailuresCount > 1 ? `Failed at ${i === 0 ? "fast" : "balanced"}` : "Failed at fast tier",
        timestamp: new Date().toISOString(),
      }));

      const story = makeStory({
        attempts: priorFailuresCount > 0 ? 0 : 1,
        priorFailures,
      });

      const ctx = makeCtx(story, {
        routing:
          priorFailuresCount === 2
            ? {
                complexity: "expert",
                modelTier: "powerful",
                testStrategy: "three-session-tdd",
                reasoning: "escalated twice",
              }
            : {
                complexity: "medium",
                modelTier: "balanced",
                testStrategy: "test-after",
                reasoning: "test",
              },
        agentResult: {
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          estimatedCost: currentAttemptCost,
          durationMs: priorFailuresCount === 2 ? 30000 : 5000,
        },
        accumulatedAttemptCost: priorAttemptCost,
      } as any);

      const metrics = collectStoryMetrics(ctx, new Date().toISOString());
      expect(metrics.cost).toBeCloseTo(expectedCost, 5);
    },
  );
});

// ---------------------------------------------------------------------------
// handleTierEscalation — preserves attempt info for BUG-067 fix
//
// After escalation, the escalated story must have priorFailures populated so
// collectStoryMetrics can reconstruct the total cross-tier attempt count.
// ---------------------------------------------------------------------------

// BUG-067
describe("handleTierEscalation — priorFailures records attempt data for cross-tier tracking", () => {
  let origSavePRD: typeof _tierEscalationDeps.savePRD;

  afterEach(() => {
    if (origSavePRD) {
      _tierEscalationDeps.savePRD = origSavePRD;
    }
  });

  test.each([
    {
      name: "escalated story has priorFailures entry identifying the failed tier",
      checkKey: "priorFailures",
      assertion: (updatedStory: any) => {
        expect(updatedStory!.priorFailures).toBeDefined();
        expect(updatedStory!.priorFailures!.length).toBeGreaterThanOrEqual(1);
        expect(updatedStory!.priorFailures![0].modelTier).toBe("fast");
      },
    },
    {
      name: "escalated story has attempts reset to 0 (BUG-011 preserved)",
      checkKey: "attempts",
      assertion: (updatedStory: any) => {
        expect(updatedStory!.attempts).toBe(0);
      },
    },
    {
      name: "escalated story modelTier is updated to next tier (regression guard)",
      checkKey: "routing",
      assertion: (updatedStory: any) => {
        expect(updatedStory!.routing?.modelTier).toBe("balanced");
      },
    },
  ])(
    "$name",
    async ({ checkKey, assertion }) => {
      origSavePRD = _tierEscalationDeps.savePRD;
      _tierEscalationDeps.savePRD = mock(() => Promise.resolve());

      const baseStory = makeStory({
        attempts: 1,
        priorFailures: [],
        ...(checkKey === "routing"
          ? {
              routing: {
                complexity: "medium",
                testStrategy: "test-after",
                reasoning: "test",
                modelTier: "fast",
              } satisfies StoryRouting,
            }
          : {}),
      });

      const ctx = {
        story: baseStory,
        storiesToExecute: [baseStory],
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
        prd: makePRD([baseStory]),
        prdPath: PRD_PATH,
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
      assertion(updatedStory);
    },
  );
});
