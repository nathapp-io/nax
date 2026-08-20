import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { DEFAULT_CONFIG } from "../../../src/config";
import { buildPlanForStrategy } from "../../../src/execution/build-plan-for-strategy";
import type { PlanInputs } from "../../../src/execution/plan-inputs";
import { implementerOp, testWriterOp, verifierOp } from "../../../src/tdd";
import type { ResolvedTestPatterns } from "../../../src/test-runners";
import { makeMockCallContext } from "@test/helpers";
import { makeRuntimeWithFakeAgent } from "@test/helpers";
import type { UserStory } from "../../../src/prd";
import { type SavedDeps, createMockAgent, mockAllSpawn, mockGitSpawn, restoreDeps, saveDeps, stubFullSuiteGateContext } from "./_tdd-test-helpers";

let saved: SavedDeps;

beforeEach(() => {
  saved = saveDeps();
  stubFullSuiteGateContext();
});

afterEach(() => {
  restoreDeps(saved);
});

const story: UserStory = {
  id: "US-001",
  title: "Add user validation",
  description: "Add validation to user input",
  acceptanceCriteria: ["Validation works", "Errors are clear"],
  dependencies: [],
  tags: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

function defaultPatterns(): ResolvedTestPatterns {
  return {
    globs: ["**/*.test.ts"],
    regex: [/\.test\.ts$/],
    pathspec: [":(exclude)**/*.test.ts"],
    testDirs: ["test/unit", "test/integration"],
    resolution: "detected",
  };
}

/**
 * Build plan inputs WITHOUT greenfieldGate so the plan runs test-writer → implementer → full-suite-gate → verifier
 * without blocking on greenfield detection. Use this for happy-path tests where we control agent output.
 */
function makePlanInputsNoGreenfield(storyOverride: UserStory = story, overrides: Partial<PlanInputs> = {}): PlanInputs {
  return {
    story: storyOverride,
    config: DEFAULT_CONFIG,
    testWriter: { story: storyOverride },
    implementer: { story: storyOverride },
    fullSuiteGate: { story: storyOverride, workdir: "/tmp/test" },
    verifier: { story: storyOverride },
    ...overrides,
  };
}

/**
 * Build plan inputs WITH greenfieldGate for tests specifically checking greenfield detection.
 */
function makePlanInputsWithGreenfield(tmpDir: string, storyOverride: UserStory = story): PlanInputs {
  return {
    story: storyOverride,
    config: DEFAULT_CONFIG,
    testWriter: { story: storyOverride },
    greenfieldGate: { story: storyOverride, workdir: tmpDir, resolvedTestPatterns: defaultPatterns() },
    implementer: { story: storyOverride },
    fullSuiteGate: { story: storyOverride, workdir: tmpDir },
    verifier: { story: storyOverride },
  };
}


describe("buildPlanForStrategy — three-session-tdd", () => {
  test("happy path: all 3 sessions succeed", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", makePlanInputsNoGreenfield());
    const result = await plan.run();

    expect(result.success).toBe(true);
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });

  test("failure when test-writer session fails", async () => {
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"]],
    });

    const agent = createMockAgent([{ success: false, exitCode: 1, estimatedCostUsd: 0.01 }]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", makePlanInputsNoGreenfield());
    const result = await plan.run();

    expect(result.success).toBe(false);
  });

  test("failure when implementer session fails", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: false, exitCode: 1, estimatedCostUsd: 0.02 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", makePlanInputsNoGreenfield());
    const result = await plan.run();

    expect(result.success).toBe(false);
  });

  test("implementer touching test files succeeds (soft-pass)", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
        ["test/user.test.ts", "src/user.ts"],
        ["test/user.test.ts", "src/user.ts"],
        [],
        [],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", makePlanInputsNoGreenfield());
    const result = await plan.run();

    expect(result.success).toBe(true);
  });

  test("BUG-20: failure when test-writer creates no test files (greenfield) — filesystem check", async () => {
    // With a real temp dir that has NO test files, the greenfield gate fails the plan
    const tmpDir = `/tmp/nax-greenfield-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(tmpDir, { recursive: true });

    try {
      mockGitSpawn({
        diffFiles: [
          ["requirements.md", "docs/plan.md"],
          ["requirements.md", "docs/plan.md"],
        ],
      });

      const agent = createMockAgent([
        { success: true, estimatedCostUsd: 0.01 },
      ]);

      const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
      const callCtx = makeMockCallContext({ runtime });
      const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", makePlanInputsWithGreenfield(tmpDir));
      const result = await plan.run();

      // Greenfield gate detects no test files → pipeline stops
      expect(result.success).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("BUG-20: success when test-writer creates test files with various extensions", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts", "test/auth.spec.js", "test/api.test.tsx"],
        ["test/user.test.ts", "test/auth.spec.js", "test/api.test.tsx"],
        ["src/user.ts", "src/auth.js"],
        ["src/user.ts", "src/auth.js"],
        ["src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const plan = await buildPlanForStrategy(callCtx, story, DEFAULT_CONFIG, "three-session-tdd", makePlanInputsNoGreenfield());
    const result = await plan.run();

    expect(result.success).toBe(true);
  });
});

// ─── #410: test-writer skip on review escalation ─────────────────────────────

describe("test-writer skip on review escalation", () => {
  test("skips test-writer when story has priorFailures with stage=review", async () => {
    // When escalation came from review stage, isFreshRun=false → test-writer is skipped by buildPlanForStrategy
    mockGitSpawn({
      diffFiles: [
        ["src/user.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
      ],
    });

    const storyWithReviewEscalation: UserStory = {
      ...story,
      attempts: 0,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "balanced",
          stage: "review",
          summary: "Semantic review found issues",
          cost: 0.05,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    // Only 2 agent calls: implementer + verifier (no test-writer)
    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const inputs = makePlanInputsNoGreenfield(storyWithReviewEscalation);
    const plan = await buildPlanForStrategy(callCtx, storyWithReviewEscalation, DEFAULT_CONFIG, "three-session-tdd", inputs);
    const result = await plan.run();

    expect(result.success).toBe(true);
    // agent.sendTurn was called exactly twice (no test-writer session since isFreshRun=false)
    expect(agent.sendTurn).toHaveBeenCalledTimes(2);
  });

  test("does not skip test-writer when priorFailures is empty (first attempt)", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
      ],
    });

    const freshStory: UserStory = {
      ...story,
      attempts: 0,
      priorFailures: [],
    };

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const inputs = makePlanInputsNoGreenfield(freshStory);
    const plan = await buildPlanForStrategy(callCtx, freshStory, DEFAULT_CONFIG, "three-session-tdd", inputs);
    const result = await plan.run();

    expect(result.success).toBe(true);
    expect(agent.sendTurn).toHaveBeenCalledTimes(3);
  });

  test("does not skip test-writer when priorFailures only have stage=escalation", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
      ],
    });

    const storyWithEscalationFailure: UserStory = {
      ...story,
      attempts: 0,
      priorFailures: [
        {
          attempt: 1,
          modelTier: "fast",
          stage: "escalation",
          summary: "Failed at verify stage, escalating",
          cost: 0.03,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const { runtime } = makeRuntimeWithFakeAgent(agent, { config: DEFAULT_CONFIG });
    const callCtx = makeMockCallContext({ runtime });
    const inputs = makePlanInputsNoGreenfield(storyWithEscalationFailure);
    const plan = await buildPlanForStrategy(callCtx, storyWithEscalationFailure, DEFAULT_CONFIG, "three-session-tdd", inputs);
    const result = await plan.run();

    expect(result.success).toBe(true);
    expect(agent.sendTurn).toHaveBeenCalledTimes(3);
  });
});
