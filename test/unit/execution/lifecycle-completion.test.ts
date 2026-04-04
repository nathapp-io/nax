/**
 * Completion Lifecycle Tests — handleRunCompletion & hooks
 *
 * Tests for run completion, hooks, regression gates, and final state management.
 * Extracted from lifecycle.test.ts for size management.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { PRD, UserStory } from "../../../src/prd";
import type { StoryMetrics } from "../../../src/metrics";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../src/execution/lifecycle/run-regression";
import type { RunCompletedEvent } from "../../../src/pipeline/event-bus";
import { pipelineEventBus } from "../../../src/pipeline/event-bus";

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
    setPostRunPhase: mock((_phase: string, _update: Record<string, unknown>) => {}),
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

const COMPLETION_WORKDIR = `/tmp/nax-test-completion-${randomUUID()}`;
const SMART_SKIP_WORKDIR = `/tmp/nax-smart-skip-test-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  workdir = COMPLETION_WORKDIR,
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
// RL-002 AC#1: on-complete hook fires after handleRunCompletion()
// ---------------------------------------------------------------------------

describe("RL-002 AC#1: on-complete hook fires after handleRunCompletion()", () => {
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
    const config = makeConfig("deferred", "bun test");

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
      await Promise.resolve();
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
    const config = makeConfig("deferred", "bun test");

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
    const config = makeConfig("deferred", "bun test");

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
      makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
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
      makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
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
      makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
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
      makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
        allStoryMetrics: metrics,
        isSequential: false,
      }),
    );

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test("does NOT skip regression when allStoryMetrics is empty (no evidence all passed)", async () => {
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(
      makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
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
      makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
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
      makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
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

    const opts = makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
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
      makeOpts(makeConfig("deferred", "bun test"), prd, SMART_SKIP_WORKDIR, {
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
    expect(call.workdir).toBe(COMPLETION_WORKDIR);
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
