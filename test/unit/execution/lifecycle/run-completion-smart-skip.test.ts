/**
 * run-completion.ts — Smart-skip deferred regression (RL-006)
 *
 * When every story has fullSuiteGatePassed === true and execution is
 * sequential, the deferred regression gate must be skipped entirely.
 *
 * Acceptance criteria:
 * - Deferred regression skipped if all stories have fullSuiteGatePassed === true
 * - Skip only applies in sequential mode
 * - Skip reason is logged
 *
 * These tests FAIL until handleRunCompletion checks fullSuiteGatePassed
 * before invoking runDeferredRegression.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import {
  type RunCompletionOptions,
  _runCompletionDeps,
  handleRunCompletion,
} from "../../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../../src/execution/lifecycle/run-regression";
import type { StoryMetrics } from "../../../../src/metrics";
import type { PRD, UserStory } from "../../../../src/prd";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"] = "passed"): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
}

function makeConfig(testCommand = "bun test"): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        mode: "deferred",
        maxRectificationAttempts: 2,
      },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: { test: testCommand },
    },
  };
}

function makeStoryMetrics(storyId: string, fullSuiteGatePassed: boolean | undefined): StoryMetrics {
  return {
    storyId,
    complexity: "simple",
    modelTier: "standard",
    modelUsed: "claude-sonnet-4-5",
    attempts: 1,
    finalTier: "standard",
    success: true,
    cost: 0.01,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    fullSuiteGatePassed,
  };
}

const MOCK_REGRESSION_SUCCESS: DeferredRegressionResult = {
  success: true,
  failedTests: 0,
  passedTests: 5,
  rectificationAttempts: 0,
  affectedStories: [],
};

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    update: mock(async () => {}),
  };
}

function makeOpts(overrides: Partial<RunCompletionOptions> = {}): RunCompletionOptions {
  const story = makeStory("US-001", "passed");
  const prd = makePRD([story]);
  return {
    runId: "run-rl006",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: [] as StoryMetrics[],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir: "/tmp/nax-smart-skip-test",
    statusWriter: makeStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config: makeConfig(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Deps injection setup
// ---------------------------------------------------------------------------

const origRunCompletionDeps = { ..._runCompletionDeps };
let mockRunDeferredRegression: ReturnType<typeof mock>;

beforeEach(() => {
  mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => MOCK_REGRESSION_SUCCESS);
  _runCompletionDeps.runDeferredRegression =
    mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;
});

afterEach(() => {
  Object.assign(_runCompletionDeps, origRunCompletionDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// RL-006: Smart-skip when all stories have fullSuiteGatePassed === true
// ---------------------------------------------------------------------------

describe("handleRunCompletion - smart-skip deferred regression (RL-006)", () => {
  test("skips regression when all stories have fullSuiteGatePassed=true in sequential mode", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", true)];

    await handleRunCompletion(
      makeOpts({
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("does NOT skip regression when at least one story has fullSuiteGatePassed=false", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", false)];

    await handleRunCompletion(
      makeOpts({
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when fullSuiteGatePassed is undefined for any story", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", undefined)];

    await handleRunCompletion(
      makeOpts({
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when all stories have fullSuiteGatePassed=true but mode is parallel", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", true)];

    await handleRunCompletion(
      makeOpts({
        allStoryMetrics: metrics,
        isSequential: false,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when allStoryMetrics is empty (no evidence all passed)", async () => {
    await handleRunCompletion(
      makeOpts({
        allStoryMetrics: [],
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when single story has fullSuiteGatePassed=false in sequential mode", async () => {
    const metrics = [makeStoryMetrics("US-001", false)];

    await handleRunCompletion(
      makeOpts({
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("skips regression with a single story with fullSuiteGatePassed=true in sequential mode", async () => {
    const metrics = [makeStoryMetrics("US-001", true)];

    await handleRunCompletion(
      makeOpts({
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("skip applies when isSequential is not provided (defaults to sequential)", async () => {
    // When isSequential is absent from options, sequential is the default behaviour
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", true)];

    // Intentionally omit isSequential to verify default behaviour
    const opts = makeOpts({ allStoryMetrics: metrics });
    // Ensure isSequential is absent
    (opts as Partial<RunCompletionOptions>).isSequential = undefined;

    await handleRunCompletion(opts);

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("result has correct shape even when regression is skipped", async () => {
    const metrics = [makeStoryMetrics("US-001", true)];

    const result = await handleRunCompletion(
      makeOpts({
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.runCompletedAt).toBe("string");
    expect(typeof result.finalCounts.total).toBe("number");
    expect(typeof result.finalCounts.passed).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// RL-006: Skip reason logging
// ---------------------------------------------------------------------------

describe("handleRunCompletion - smart-skip logging (RL-006)", () => {
  test("smart-skip does not call runDeferredRegression (logging verified indirectly via no-call)", async () => {
    // The skip reason is logged via the project logger (getSafeLogger).
    // Since logger injection is not part of _runCompletionDeps, we verify
    // the skip behaviour indirectly: if runDeferredRegression is not called
    // yet the function completes successfully, the log+skip path executed.
    const metrics = [
      makeStoryMetrics("US-001", true),
      makeStoryMetrics("US-002", true),
      makeStoryMetrics("US-003", true),
    ];

    const result = await handleRunCompletion(
      makeOpts({
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
    // Function must still complete and return a valid result
    expect(result).toBeDefined();
    expect(result.finalCounts).toBeDefined();
  });
});
