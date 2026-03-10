// RE-ARCH: keep
/**
 * Execution Lifecycle Tests
 *
 * Consolidated from 5 lifecycle test files:
 * - run-regression.test.ts: Smart Runner reverse mapping + deferred regression gate
 * - rl002-on-complete-after-regression.test.ts: on-complete hook fires after completion
 * - rl003-on-final-regression-fail.test.ts: on-final-regression-fail hook fires on failure
 * - run-completion-smart-skip.test.ts: Smart-skip deferred regression (RL-006)
 * - run-completion.test.ts: Deferred regression gate invocation (US-003)
 */

import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { PRD, UserStory } from "../../../src/prd";
import type { PRD as PRDTypes, UserStory as UserStoryTypes } from "../../../src/prd/types";
import type { StoryMetrics } from "../../../src/metrics";
import {
  _regressionDeps,
  runDeferredRegression,
} from "../../../src/execution/lifecycle/run-regression";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../src/execution/lifecycle/run-regression";
import type { VerificationResult } from "../../../src/verification";
import type { RunCompletedEvent } from "../../../src/pipeline/event-bus";
import { pipelineEventBus } from "../../../src/pipeline/event-bus";
import { HOOK_EVENTS } from "../../../src/hooks/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
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

function makePRD(stories: Array<{ id: string; status: UserStory["status"] }>): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories.map(({ id, status }) => makeStory(id, status)),
  };
}

function makeConfig(
  regressionMode?: "deferred" | "per-story" | "disabled",
  testCommand?: string,
): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        ...(regressionMode !== undefined ? { mode: regressionMode } : {}),
        maxRectificationAttempts: 2,
      },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: {
        ...(testCommand ? { test: testCommand } : {}),
      },
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

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  workdir = "/tmp/nax-test-completion",
  overrides?: Partial<RunCompletionOptions>,
): RunCompletionOptions {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: [] as StoryMetrics[],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir,
    statusWriter: makeStatusWriter() as unknown as RunCompletionOptions["statusWriter"],
    config,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// run-regression.test.ts: reverseMapTestToSource
// ---------------------------------------------------------------------------

describe("reverseMapTestToSource", () => {
  test("should map test/unit files to source files", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/unit/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should map test/integration files to source files", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/integration/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should ignore non-test files", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/src/foo/bar.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });

  test("should deduplicate results", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/unit/foo/bar.test.ts", "/repo/test/integration/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should handle paths without leading workdir", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["test/unit/foo/bar.test.ts"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/foo/bar.ts"]);
  });

  test("should preserve order when mapping multiple files", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = [
      "/repo/test/unit/aaa.test.ts",
      "/repo/test/unit/bbb.test.ts",
      "/repo/test/unit/ccc.test.ts",
    ];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual(["src/aaa.ts", "src/bbb.ts", "src/ccc.ts"]);
  });

  test("should handle empty input", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles: string[] = [];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });

  test("should filter out files with .test.js extension", async () => {
    const { reverseMapTestToSource } = await import("../../../src/verification/smart-runner");

    const testFiles = ["/repo/test/unit/foo.js"];
    const result = reverseMapTestToSource(testFiles, "/repo");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// run-regression.test.ts: runDeferredRegression
// ---------------------------------------------------------------------------

describe("runDeferredRegression", () => {
  test("returns success immediately when mode is 'disabled'", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-disabled",
    });

    expect(result.success).toBe(true);
    expect(result.failedTests).toBe(0);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("returns success immediately when mode is 'per-story' (deferred not applicable)", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("per-story", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-per-story",
    });

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("returns success when no passed stories exist (partial completion)", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "pending" },
        { id: "US-002", status: "failed" },
      ]),
      workdir: "/tmp/nax-test-no-passed",
    });

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(0);
    expect(result.failedTests).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("result shape has all required fields", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([]),
      workdir: "/tmp/nax-test-shape",
    });

    expect(typeof result.success).toBe("boolean");
    expect(typeof result.failedTests).toBe("number");
    expect(typeof result.passedTests).toBe("number");
    expect(typeof result.rectificationAttempts).toBe("number");
    expect(Array.isArray(result.affectedStories)).toBe(true);
  });

  test("affectedStories contains only string values", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-story-ids",
    });

    for (const storyId of result.affectedStories) {
      expect(typeof storyId).toBe("string");
    }
  });

  test("passedTests is non-negative integer", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-counts",
    });

    expect(result.passedTests).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.passedTests)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// run-regression.test.ts: behavioral tests
// ---------------------------------------------------------------------------

const origRegressionDeps = {
  runVerification: _regressionDeps.runVerification,
  runRectificationLoop: _regressionDeps.runRectificationLoop,
  parseBunTestOutput: _regressionDeps.parseBunTestOutput,
  reverseMapTestToSource: _regressionDeps.reverseMapTestToSource,
};

beforeEach(() => {
  _regressionDeps.runRectificationLoop = mock(async () => false);
  _regressionDeps.reverseMapTestToSource = mock(() => []);
});

afterEach(() => {
  Object.assign(_regressionDeps, origRegressionDeps);
  mock.restore();
});

describe("runDeferredRegression - behavioral tests (with mocked deps)", () => {
  test("full suite passes → success with 0 rectification attempts", async () => {
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => ({
      status: "SUCCESS",
      success: true,
      countsTowardEscalation: true,
      passCount: 42,
    }));

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-behavioral",
    });

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(42);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("TIMEOUT + acceptOnTimeout=true → success", async () => {
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => ({
      status: "TIMEOUT",
      success: false,
      countsTowardEscalation: false,
    }));

    const config = makeConfig("deferred", "bun test");
    const result = await runDeferredRegression({
      config,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-timeout-accept",
    });

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(0);
  });

  test("TIMEOUT + acceptOnTimeout=false → failure", async () => {
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => ({
      status: "TIMEOUT",
      success: false,
      countsTowardEscalation: false,
    }));

    const config: NaxConfig = {
      ...makeConfig("deferred", "bun test"),
      execution: {
        ...makeConfig("deferred", "bun test").execution,
        regressionGate: {
          enabled: true,
          timeoutSeconds: 30,
          acceptOnTimeout: false,
          mode: "deferred",
          maxRectificationAttempts: 2,
        },
      },
    };

    const result = await runDeferredRegression({
      config,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-timeout-reject",
    });

    expect(result.success).toBe(false);
  });

  test("full suite fails with no output → failure immediately (no rectification)", async () => {
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => ({
      status: "TEST_FAILURE",
      success: false,
      countsTowardEscalation: true,
      failCount: 3,
    }));

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: "/tmp/nax-test-no-output",
    });

    expect(result.success).toBe(false);
    expect(result.rectificationAttempts).toBe(0);
  });

  test("unmapped failures (no file field) → all passed stories in affectedStories", async () => {
    let verCallCount = 0;
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => {
      verCallCount++;
      if (verCallCount === 1) {
        return {
          status: "TEST_FAILURE",
          success: false,
          countsTowardEscalation: true,
          output: "FAIL: some test\nerror: boom",
          failCount: 1,
        };
      }
      return {
        status: "TEST_FAILURE",
        success: false,
        countsTowardEscalation: true,
        failCount: 1,
      };
    });

    _regressionDeps.parseBunTestOutput = mock(() => ({
      failed: 1,
      passed: 5,
      failures: [{ testName: "some test", error: "boom" }],
    })) as unknown as typeof _regressionDeps.parseBunTestOutput;

    _regressionDeps.runRectificationLoop = mock(async () => false);

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "passed" },
        { id: "US-002", status: "passed" },
      ]),
      workdir: "/tmp/nax-test-unmapped",
    });

    expect(result.affectedStories).toContain("US-001");
    expect(result.affectedStories).toContain("US-002");
  });
});

// ---------------------------------------------------------------------------
// RL-002 AC#1: on-complete fires AFTER handleRunCompletion finishes
// ---------------------------------------------------------------------------

const origRunCompletionDeps = { ..._runCompletionDeps };

beforeEach(() => {
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

describe("RL-002 AC#1: on-complete hook fires after handleRunCompletion()", () => {
  test("run:completed event is emitted AFTER handleRunCompletion resolves", async () => {
    const callOrder: string[] = [];

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

    const capturedEvents: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      callOrder.push("run:completed-event");
      capturedEvents.push(ev);
    });

    const prd = makePRD([{ id: "US-001", status: "passed" }, { id: "US-002", status: "passed" }]);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));

      expect(callOrder).toContain("regression-gate");
      expect(callOrder).toContain("run:completed-event");

      const regressionIdx = callOrder.indexOf("regression-gate");
      const completedIdx = callOrder.indexOf("run:completed-event");
      expect(regressionIdx).toBeLessThan(completedIdx);
    } finally {
      unsub();
    }
  });

  test("on-complete hook does not fire before regression gate completes", async () => {
    let regressionFinished = false;
    let completedFiredBeforeRegression = false;

    _runCompletionDeps.runDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => {
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

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));

      expect(regressionFinished).toBe(true);
      expect(completedFiredBeforeRegression).toBe(false);
    } finally {
      unsub();
    }
  });
});

// ---------------------------------------------------------------------------
// RL-002 AC#3: Hook payload reflects final success status
// ---------------------------------------------------------------------------

describe("RL-002 AC#3: run:completed payload reflects final success status", () => {
  test("run:completed event has correct story counts (not placeholder 0/0/0)", async () => {
    const stories = [
      makeStory("US-001", "passed"),
      makeStory("US-002", "passed"),
      makeStory("US-003", "failed"),
    ];
    const prd = makePRD(stories.map((s) => ({ id: s.id, status: s.status })));
    const config = makeConfig("disabled");

    let completionResult: Awaited<ReturnType<typeof handleRunCompletion>>;
    try {
      completionResult = await handleRunCompletion(makeOpts(config, prd));
    } catch {
      return;
    }

    expect(completionResult.finalCounts.total).toBe(3);
    expect(completionResult.finalCounts.passed).toBe(2);
    expect(completionResult.finalCounts.failed).toBe(1);

    expect(completionResult.finalCounts.total).toBeGreaterThan(0);
  });

  test("run:completed event payload includes regression success when regression passes", async () => {
    const capturedEvents: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedEvents.push(ev);
    });

    const stories = [{ id: "US-001", status: "passed" as const }, { id: "US-002", status: "passed" as const }];
    const prd = makePRD(stories);
    const config = makeConfig("deferred");

    try {
      await handleRunCompletion(makeOpts(config, prd));

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]?.totalStories).toBe(2);
      expect(capturedEvents[0]?.passedStories).toBe(2);
      expect(capturedEvents[0]?.failedStories).toBe(0);
    } finally {
      unsub();
    }
  });

  test("run:completed event totalCost matches actual run cost", async () => {
    const capturedEvents: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedEvents.push(ev);
    });

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("disabled");
    const opts = makeOpts(config, prd);
    opts.totalCost = 2.75;

    try {
      await handleRunCompletion(opts);

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]?.totalCost).toBe(2.75);
    } finally {
      unsub();
    }
  });
});

// ---------------------------------------------------------------------------
// handleRunCompletion - smart-skip deferred regression (RL-006)
// ---------------------------------------------------------------------------

let mockRunDeferredRegression: ReturnType<typeof mock>;

beforeEach(() => {
  mockRunDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => ({
    success: true,
    failedTests: 0,
    passedTests: 5,
    rectificationAttempts: 0,
    affectedStories: [],
  }));
  _runCompletionDeps.runDeferredRegression =
    mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;
});

describe("handleRunCompletion - smart-skip deferred regression (RL-006)", () => {
  test("skips regression when all stories have fullSuiteGatePassed=true in sequential mode", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", true)];
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);

    await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("does NOT skip regression when at least one story has fullSuiteGatePassed=false", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", false)];
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);

    await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when fullSuiteGatePassed is undefined for any story", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", undefined)];
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);

    await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when all stories have fullSuiteGatePassed=true but mode is parallel", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", true)];
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);

    await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
        allStoryMetrics: metrics,
        isSequential: false,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when allStoryMetrics is empty (no evidence all passed)", async () => {
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
        allStoryMetrics: [],
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when single story has fullSuiteGatePassed=false in sequential mode", async () => {
    const metrics = [makeStoryMetrics("US-001", false)];
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("skips regression with a single story with fullSuiteGatePassed=true in sequential mode", async () => {
    const metrics = [makeStoryMetrics("US-001", true)];
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
        allStoryMetrics: metrics,
        isSequential: true,
      }),
    );

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("skip applies when isSequential is not provided (defaults to sequential)", async () => {
    const metrics = [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", true)];
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);

    const opts = makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
      allStoryMetrics: metrics,
    });
    (opts as Partial<RunCompletionOptions>).isSequential = undefined;

    await handleRunCompletion(opts);

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("result has correct shape even when regression is skipped", async () => {
    const metrics = [makeStoryMetrics("US-001", true)];
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    const result = await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, "/tmp/nax-smart-skip-test", {
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
// handleRunCompletion - deferred regression gate
// ---------------------------------------------------------------------------

const MOCK_REGRESSION_SUCCESS: DeferredRegressionResult = {
  success: true,
  failedTests: 0,
  passedTests: 5,
  rectificationAttempts: 0,
  affectedStories: [],
};

describe("handleRunCompletion - deferred regression gate", () => {
  test("calls runDeferredRegression when mode is 'deferred' and test command exists", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      //
    }

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    const call = mockRunDeferredRegression.mock.calls[0][0] as { workdir: string };
    expect(call.workdir).toBe("/tmp/nax-test-completion");
  });

  test("does NOT call runDeferredRegression when mode is 'per-story'", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("per-story", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      //
    }

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("does NOT call runDeferredRegression when mode is 'disabled'", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("disabled", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      //
    }

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("does NOT call runDeferredRegression when no test command is configured", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", undefined);

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      //
    }

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
  });

  test("calls runDeferredRegression with the correct workdir", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd, "/custom/workdir"));
    } catch {
      //
    }

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    const call = mockRunDeferredRegression.mock.calls[0][0] as { workdir: string };
    expect(call.workdir).toBe("/custom/workdir");
  });

  test("calls runDeferredRegression with prd and config", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      //
    }

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    const call = mockRunDeferredRegression.mock.calls[0][0] as {
      config: NaxConfig;
      prd: PRD;
    };
    expect(call.config).toBe(config);
    expect(call.prd).toBe(prd);
  });
});

// ---------------------------------------------------------------------------
// RL-004: Regression-failed story marking and run status
// ---------------------------------------------------------------------------

const MOCK_REGRESSION_FAILURE: DeferredRegressionResult = {
  success: false,
  failedTests: 3,
  passedTests: 10,
  rectificationAttempts: 2,
  affectedStories: ["US-001"],
};

describe("handleRunCompletion - regression-failed story marking (RL-004)", () => {
  test("marks affected story as 'regression-failed' when regression gate fails", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", "bun test");
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => MOCK_REGRESSION_FAILURE,
    ) as typeof _runCompletionDeps.runDeferredRegression;

    await handleRunCompletion(makeOpts(config, prd));

    expect(prd.userStories[0].status).toBe("regression-failed");
  });

  test("does not change status of stories absent from affectedStories", async () => {
    const story1 = makeStory("US-001", "passed");
    const story2 = makeStory("US-002", "passed");
    const prd = makePRD([
      { id: story1.id, status: story1.status },
      { id: story2.id, status: story2.status },
    ]);
    const config = makeConfig("deferred", "bun test");
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        ...MOCK_REGRESSION_FAILURE,
        affectedStories: ["US-001"],
      }),
    ) as typeof _runCompletionDeps.runDeferredRegression;

    await handleRunCompletion(makeOpts(config, prd));

    expect(prd.userStories[0].status).toBe("regression-failed");
    expect(prd.userStories[1].status).toBe("passed");
  });

  test("marks multiple affected stories as 'regression-failed'", async () => {
    const story1 = makeStory("US-001", "passed");
    const story2 = makeStory("US-002", "passed");
    const story3 = makeStory("US-003", "passed");
    const prd = makePRD([
      { id: story1.id, status: story1.status },
      { id: story2.id, status: story2.status },
      { id: story3.id, status: story3.status },
    ]);
    const config = makeConfig("deferred", "bun test");
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        ...MOCK_REGRESSION_FAILURE,
        affectedStories: ["US-001", "US-003"],
      }),
    ) as typeof _runCompletionDeps.runDeferredRegression;

    await handleRunCompletion(makeOpts(config, prd));

    expect(prd.userStories[0].status).toBe("regression-failed");
    expect(prd.userStories[1].status).toBe("passed");
    expect(prd.userStories[2].status).toBe("regression-failed");
  });

  test("does not mark stories 'regression-failed' when regression gate succeeds", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", "bun test");

    await handleRunCompletion(makeOpts(config, prd));

    expect(prd.userStories[0].status).toBe("passed");
  });

  test("does not mark stories 'regression-failed' when mode is not 'deferred'", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("per-story", "bun test");

    await handleRunCompletion(makeOpts(config, prd));

    expect(prd.userStories[0].status).toBe("passed");
  });
});

describe("handleRunCompletion - run status on regression failure (RL-004)", () => {
  test("sets run status to 'failed' when regression gate fails", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", "bun test");
    const statusWriter = makeStatusWriter();
    const opts: RunCompletionOptions = {
      ...makeOpts(config, prd),
      statusWriter: statusWriter as unknown as RunCompletionOptions["statusWriter"],
    };
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => MOCK_REGRESSION_FAILURE,
    ) as typeof _runCompletionDeps.runDeferredRegression;

    await handleRunCompletion(opts);

    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("failed");
  });

  test("does not set run status to 'failed' when regression gate succeeds", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", "bun test");
    const statusWriter = makeStatusWriter();
    const opts: RunCompletionOptions = {
      ...makeOpts(config, prd),
      statusWriter: statusWriter as unknown as RunCompletionOptions["statusWriter"],
    };

    await handleRunCompletion(opts);

    expect(statusWriter.setRunStatus).not.toHaveBeenCalledWith("failed");
  });

  test("sets run status to 'failed' even when all stories were passed before regression", async () => {
    const story1 = makeStory("US-001", "passed");
    const story2 = makeStory("US-002", "passed");
    const prd = makePRD([
      { id: story1.id, status: story1.status },
      { id: story2.id, status: story2.status },
    ]);
    const config = makeConfig("deferred", "bun test");
    const statusWriter = makeStatusWriter();
    const opts: RunCompletionOptions = {
      ...makeOpts(config, prd),
      statusWriter: statusWriter as unknown as RunCompletionOptions["statusWriter"],
    };
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => MOCK_REGRESSION_FAILURE,
    ) as typeof _runCompletionDeps.runDeferredRegression;

    await handleRunCompletion(opts);

    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("failed");
  });
});
