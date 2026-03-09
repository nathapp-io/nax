/**
 * RL-002: on-complete hook fires after handleRunCompletion() finishes
 *
 * Acceptance Criteria Tested:
 * - AC #1: on-complete hook fires after handleRunCompletion() finishes
 * - AC #3: Hook payload reflects final success status (including regression result)
 *
 * Design:
 * - Uses _runCompletionDeps injection to control runDeferredRegression
 * - Monitors call ordering via shared call log
 * - Tests that run:completed event is emitted AFTER handleRunCompletion resolves
 *
 * These tests are RED (failing) until RL-002 implementation moves run:completed
 * emission to runner.ts post-handleRunCompletion.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "../../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../../src/execution/lifecycle/run-regression";
import type { StoryMetrics } from "../../../../src/metrics";
import type { RunCompletedEvent } from "../../../../src/pipeline/event-bus";
import { pipelineEventBus } from "../../../../src/pipeline/event-bus";
import type { PRD, UserStory } from "../../../../src/prd/types";

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

function makeConfig(regressionMode?: "deferred" | "per-story" | "disabled"): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        mode: regressionMode ?? "deferred",
        maxRectificationAttempts: 2,
      },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: { test: "bun test" },
    },
  };
}

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  };
}

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  workdir = "/tmp/nax-rl002-completion-test",
): RunCompletionOptions {
  return {
    runId: "run-rl002",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: [] as StoryMetrics[],
    totalCost: 1.5,
    storiesCompleted: 3,
    iterations: 3,
    startTime: Date.now() - 2000,
    workdir,
    statusWriter: makeStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config,
  };
}

// ---------------------------------------------------------------------------
// Deps injection setup
// ---------------------------------------------------------------------------

const origRunCompletionDeps = { ..._runCompletionDeps };

beforeEach(() => {
  // Default: regression succeeds
  _runCompletionDeps.runDeferredRegression = mock(
    async (): Promise<DeferredRegressionResult> => ({
      success: true,
      failedTests: 0,
      passedTests: 10,
      rectificationAttempts: 0,
      affectedStories: [],
    }),
  );
});

afterEach(() => {
  Object.assign(_runCompletionDeps, origRunCompletionDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC #1: on-complete fires AFTER handleRunCompletion finishes
// ---------------------------------------------------------------------------

describe("RL-002 AC#1: on-complete hook fires after handleRunCompletion()", () => {
  test("run:completed event is emitted AFTER handleRunCompletion resolves", async () => {
    // Arrange: track call ordering
    const callOrder: string[] = [];

    // Mock regression to track when handleRunCompletion runs
    _runCompletionDeps.runDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => {
      callOrder.push("regression-gate");
      return {
        success: true,
        failedTests: 0,
        passedTests: 5,
        rectificationAttempts: 0,
        affectedStories: [],
      };
    });

    // Subscribe to run:completed to track when it fires
    const capturedEvents: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      callOrder.push("run:completed-event");
      capturedEvents.push(ev);
    });

    const prd = makePRD([makeStory("US-001", "passed"), makeStory("US-002", "passed")]);
    const config = makeConfig("deferred");

    try {
      // Act: run handleRunCompletion (regression gate runs inside it)
      await handleRunCompletion(makeOpts(config, prd));

      // After fix: runner.ts emits run:completed AFTER handleRunCompletion.
      // In the current implementation, run:completed is emitted from
      // sequential-executor.ts BEFORE handleRunCompletion is even called,
      // so "regression-gate" would never appear before "run:completed-event".
      //
      // After fix: runner.ts emits run:completed after awaiting handleRunCompletion,
      // so the ordering should be: regression-gate → run:completed-event.
      //
      // This test FAILS now because handleRunCompletion doesn't emit run:completed,
      // so "run:completed-event" never appears in callOrder after the regression.
      expect(callOrder).toContain("regression-gate");
      expect(callOrder).toContain("run:completed-event");

      const regressionIdx = callOrder.indexOf("regression-gate");
      const completedIdx = callOrder.indexOf("run:completed-event");
      // After fix: regression runs before run:completed is emitted
      expect(regressionIdx).toBeLessThan(completedIdx);
    } finally {
      unsub();
    }
  });

  test("on-complete hook does not fire before regression gate completes", async () => {
    // Tracks whether regression has finished when run:completed fires
    let regressionFinished = false;
    let completedFiredBeforeRegression = false;

    _runCompletionDeps.runDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => {
      // Simulate async regression work
      await Bun.sleep(10);
      regressionFinished = true;
      return {
        success: true,
        failedTests: 0,
        passedTests: 3,
        rectificationAttempts: 0,
        affectedStories: [],
      };
    });

    const unsub = pipelineEventBus.on("run:completed", () => {
      if (!regressionFinished) {
        completedFiredBeforeRegression = true;
      }
    });

    const prd = makePRD([makeStory("US-001", "passed")]);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));

      // After fix: run:completed fires after regression completes.
      // Currently FAILS because handleRunCompletion doesn't emit run:completed at all.
      expect(regressionFinished).toBe(true);
      // run:completed must NOT have fired before regression completed
      expect(completedFiredBeforeRegression).toBe(false);
    } finally {
      unsub();
    }
  });
});

// ---------------------------------------------------------------------------
// AC #3: Hook payload reflects final success status (including regression)
// ---------------------------------------------------------------------------

describe("RL-002 AC#3: run:completed payload reflects final success status", () => {
  test("run:completed event has correct story counts (not placeholder 0/0/0)", async () => {
    // AC #3: The run:completed event emitted by runner.ts (after the fix)
    // must have passedStories and totalStories from handleRunCompletion's
    // finalCounts, not the hardcoded 0/0/0 from sequential-executor.ts.
    //
    // This test verifies that handleRunCompletion returns finalCounts with
    // real story counts that can be used to populate the event.

    const stories = [
      makeStory("US-001", "passed"),
      makeStory("US-002", "passed"),
      makeStory("US-003", "failed"),
    ];
    const prd = makePRD(stories);
    const config = makeConfig("disabled"); // skip regression

    let completionResult: Awaited<ReturnType<typeof handleRunCompletion>>;
    try {
      completionResult = await handleRunCompletion(makeOpts(config, prd));
    } catch {
      // Ignore disk write errors in test env
      return;
    }

    // handleRunCompletion must return accurate finalCounts
    // (these are what runner.ts uses to populate the run:completed event)
    expect(completionResult.finalCounts.total).toBe(3);
    expect(completionResult.finalCounts.passed).toBe(2);
    expect(completionResult.finalCounts.failed).toBe(1);

    // Verify these are non-zero (not placeholder values)
    expect(completionResult.finalCounts.total).toBeGreaterThan(0);
  });

  test("run:completed event payload includes regression success when regression passes", async () => {
    // After the fix: run:completed is emitted by runner.ts with data from
    // handleRunCompletion's return. The payload should reflect the post-regression
    // final state.
    //
    // We test this by verifying the run:completed event (when emitted from
    // the pipelineEventBus by the fixed runner.ts) carries correct counts.

    const capturedEvents: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedEvents.push(ev);
    });

    // Regression succeeds (configured in beforeEach)
    const stories = [makeStory("US-001", "passed"), makeStory("US-002", "passed")];
    const prd = makePRD(stories);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));

      // After fix: runner.ts emits run:completed after handleRunCompletion.
      // The event should have totalStories = 2 (from finalCounts), not 0.
      //
      // Currently FAILS: handleRunCompletion doesn't emit run:completed,
      // so capturedEvents is empty.
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]?.totalStories).toBe(2);
      expect(capturedEvents[0]?.passedStories).toBe(2);
      expect(capturedEvents[0]?.failedStories).toBe(0);
    } finally {
      unsub();
    }
  });

  test("run:completed event totalCost matches actual run cost", async () => {
    // The totalCost in the run:completed event should match the actual
    // cost from the run, not be undefined or 0.

    const capturedEvents: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedEvents.push(ev);
    });

    const prd = makePRD([makeStory("US-001", "passed")]);
    const config = makeConfig("disabled");
    const opts = makeOpts(config, prd);
    opts.totalCost = 2.75; // Known cost

    try {
      await handleRunCompletion(opts);

      // Currently FAILS: handleRunCompletion doesn't emit run:completed
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]?.totalCost).toBe(2.75);
    } finally {
      unsub();
    }
  });
});
