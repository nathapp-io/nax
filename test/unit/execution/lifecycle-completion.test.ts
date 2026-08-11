/**
 * Completion Lifecycle Tests — handleRunCompletion & hooks
 *
 * Tests for run completion, hooks, regression gates, and final state management.
 * Extracted from lifecycle.test.ts for size management.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "@/config";
import {
  type RunCompletionOptions,
  _runCompletionDeps,
  handleRunCompletion,
} from "@/execution/lifecycle";
import type { DeferredRegressionResult } from "@/execution/lifecycle/run-regression";
import * as loggerModule from "@/logger";
import type { StoryMetrics } from "@/metrics";
import type { RunCompletedEvent } from "@/pipeline";
import { pipelineEventBus } from "@/pipeline";
import type { PRD, UserStory } from "@/prd";
import { makeMockRuntime, makeNaxConfig } from "@test/helpers";

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

function makeConfig(regressionMode?: "deferred" | "per-story" | "disabled", testCommand?: string): NaxConfig {
  return makeNaxConfig({
    execution: {
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        ...(regressionMode !== undefined ? { mode: regressionMode } : {}),
      },
    },
    quality: {
      commands: {
        ...(testCommand ? { test: testCommand } : {}),
      },
    },
  });
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
    runtime: makeMockRuntime(),
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

    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);
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
    const stories = [makeStory("US-001", "passed"), makeStory("US-002", "passed"), makeStory("US-003", "failed")];
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

    const stories = [
      { id: "US-001", status: "passed" as const },
      { id: "US-002", status: "passed" as const },
    ];
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
    opts.runtime.costAggregator.record({
      ts: Date.now(),
      runId: "run-001",
      agentName: "claude",
      model: "test",
      storyId: "US-001",
      tokens: { input: 0, output: 0 },
      estimatedCostUsd: 2.75,
      exactCostUsd: 2.75,
      costUsd: 2.75,
      confidence: "exact",
      durationMs: 0,
    });

    try {
      await handleRunCompletion(opts);

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]?.totalCost).toBeCloseTo(2.75, 2);
    } finally {
      unsub();
    }
  });
});

// ---------------------------------------------------------------------------
// handleRunCompletion - deferred regression always runs in deferred mode
// ---------------------------------------------------------------------------

let mockRunDeferredRegression: ReturnType<typeof mock>;

beforeEach(() => {
  mockRunDeferredRegression = mock(
    async (): Promise<DeferredRegressionResult> => ({
      success: true,
      failedTests: 0,
      passedTests: 5,
      rectificationAttempts: 0,
      affectedStories: [],
    }),
  );
  _runCompletionDeps.runDeferredRegression =
    mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;
});

describe("handleRunCompletion - deferred regression is not smart-skipped", () => {
  test("always runs regression regardless of fullSuiteGatePassed values (true, false, or undefined) in sequential mode", async () => {
    const cfg = makeConfig("deferred", "bun test");
    const prd2 = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);

    await handleRunCompletion(
      makeOpts(cfg, prd2, SMART_SKIP_WORKDIR, {
        allStoryMetrics: [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", true)],
        isSequential: true,
      }),
    );
    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    mockRunDeferredRegression.mockClear();

    await handleRunCompletion(
      makeOpts(cfg, prd2, SMART_SKIP_WORKDIR, {
        allStoryMetrics: [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", false)],
        isSequential: true,
      }),
    );
    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    mockRunDeferredRegression.mockClear();

    await handleRunCompletion(
      makeOpts(cfg, prd2, SMART_SKIP_WORKDIR, {
        allStoryMetrics: [makeStoryMetrics("US-001", true), makeStoryMetrics("US-002", undefined)],
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

  test("runs regression for single story (false/true gatePassed), no-isSequential; result has correct shape", async () => {
    const cfg = makeConfig("deferred", "bun test");
    const prd1 = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(
      makeOpts(cfg, prd1, SMART_SKIP_WORKDIR, {
        allStoryMetrics: [makeStoryMetrics("US-001", false)],
        isSequential: true,
      }),
    );
    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    mockRunDeferredRegression.mockClear();

    await handleRunCompletion(
      makeOpts(cfg, prd1, SMART_SKIP_WORKDIR, {
        allStoryMetrics: [makeStoryMetrics("US-001", true)],
        isSequential: true,
      }),
    );
    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    mockRunDeferredRegression.mockClear();

    const noSeqOpts = makeOpts(cfg, prd1, SMART_SKIP_WORKDIR, { allStoryMetrics: [makeStoryMetrics("US-001", true)] });
    (noSeqOpts as Partial<RunCompletionOptions>).isSequential = undefined;
    const result = await handleRunCompletion(noSeqOpts);
    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.runCompletedAt).toBe("string");
    expect(typeof result.finalCounts.total).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// handleRunCompletion - deferred regression gate
// ---------------------------------------------------------------------------

describe("handleRunCompletion - deferred regression gate", () => {
  test("calls runDeferredRegression when mode is 'deferred' with test command; not otherwise", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("deferred", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      /* ignore */
    }

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
    const call0 = mockRunDeferredRegression.mock.calls[0][0] as { workdir: string; config: NaxConfig; prd: PRD };
    expect(call0.workdir).toBe(COMPLETION_WORKDIR);
    expect(call0.config).toBe(config);
    expect(call0.prd).toBe(prd);
    mockRunDeferredRegression.mockClear();

    try {
      await handleRunCompletion(makeOpts(config, prd, "/custom/workdir"));
    } catch {
      /* ignore */
    }
    expect((mockRunDeferredRegression.mock.calls[0][0] as { workdir: string }).workdir).toBe("/custom/workdir");
  });

  test("calls runDeferredRegression when mode is 'per-story' (superset of deferred)", async () => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);
    const config = makeConfig("per-story", "bun test");

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      /* ignore */
    }

    expect(mockRunDeferredRegression).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["mode is 'disabled'", makeConfig("disabled", "bun test")],
    ["no test command is configured", makeConfig("deferred", undefined)],
  ])("does NOT call runDeferredRegression when %s", async (_label, config) => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);

    try {
      await handleRunCompletion(makeOpts(config, prd));
    } catch {
      //
    }

    expect(mockRunDeferredRegression).not.toHaveBeenCalled();
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
  test("marks affected stories as 'regression-failed'; leaves unaffected stories unchanged", async () => {
    const config = makeConfig("deferred", "bun test");

    const prd1 = makePRD([{ id: "US-001", status: "passed" }]);
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => MOCK_REGRESSION_FAILURE,
    ) as typeof _runCompletionDeps.runDeferredRegression;
    await handleRunCompletion(makeOpts(config, prd1));
    expect(prd1.userStories[0].status).toBe("regression-failed");

    const prd3 = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
      { id: "US-003", status: "passed" },
    ]);
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        ...MOCK_REGRESSION_FAILURE,
        affectedStories: ["US-001", "US-003"],
      }),
    ) as typeof _runCompletionDeps.runDeferredRegression;
    await handleRunCompletion(makeOpts(config, prd3));
    expect(prd3.userStories[0].status).toBe("regression-failed");
    expect(prd3.userStories[1].status).toBe("passed");
    expect(prd3.userStories[2].status).toBe("regression-failed");
  });

  test.each([
    ["regression gate succeeds", makeConfig("deferred", "bun test")],
    ["mode is not 'deferred'", makeConfig("per-story", "bun test")],
  ])("does not mark stories 'regression-failed' when %s", async (_label, config) => {
    const story = makeStory("US-001", "passed");
    const prd = makePRD([{ id: story.id, status: story.status }]);

    await handleRunCompletion(makeOpts(config, prd));

    expect(prd.userStories[0].status).toBe("passed");
  });
});

describe("handleRunCompletion - run status on regression failure (RL-004)", () => {
  test("sets run status to 'failed' when regression gate fails; does not set 'failed' when it succeeds", async () => {
    const config = makeConfig("deferred", "bun test");

    const failWriter = makeStatusWriter();
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => MOCK_REGRESSION_FAILURE,
    ) as typeof _runCompletionDeps.runDeferredRegression;
    const prd2 = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);
    await handleRunCompletion({
      ...makeOpts(config, prd2),
      statusWriter: failWriter as unknown as RunCompletionOptions["statusWriter"],
    });
    expect(failWriter.setRunStatus).toHaveBeenCalledWith("failed");

    // Restore success mock for second sub-scenario
    _runCompletionDeps.runDeferredRegression =
      mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression;
    const passWriter = makeStatusWriter();
    const prd1 = makePRD([{ id: "US-001", status: "passed" }]);
    await handleRunCompletion({
      ...makeOpts(config, prd1),
      statusWriter: passWriter as unknown as RunCompletionOptions["statusWriter"],
    });
    expect(passWriter.setRunStatus).not.toHaveBeenCalledWith("failed");
  });
});

describe("handleRunCompletion - cost-limit exitReason surfaces distinctly", () => {
  test("sets run status to 'cost-limit' when exitReason is 'cost-limit', regardless of PRD completeness", async () => {
    const config = makeConfig("deferred", "bun test");
    const statusWriter = makeStatusWriter();
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "pending" },
    ]);

    await handleRunCompletion({
      ...makeOpts(config, prd, undefined, { exitReason: "cost-limit" }),
      statusWriter: statusWriter as unknown as RunCompletionOptions["statusWriter"],
    });

    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("cost-limit");
  });

  test("does not set 'cost-limit' when exitReason is absent, even with an incomplete PRD", async () => {
    const config = makeConfig("deferred", "bun test");
    const statusWriter = makeStatusWriter();
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "pending" },
    ]);

    await handleRunCompletion({
      ...makeOpts(config, prd),
      statusWriter: statusWriter as unknown as RunCompletionOptions["statusWriter"],
    });

    expect(statusWriter.setRunStatus).not.toHaveBeenCalledWith("cost-limit");
  });

  test("a genuine regression-gate failure is not masked by a cost-limit exitReason", async () => {
    const config = makeConfig("deferred", "bun test");
    const statusWriter = makeStatusWriter();
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => MOCK_REGRESSION_FAILURE,
    ) as typeof _runCompletionDeps.runDeferredRegression;

    await handleRunCompletion({
      ...makeOpts(config, prd, undefined, { exitReason: "cost-limit" }),
      statusWriter: statusWriter as unknown as RunCompletionOptions["statusWriter"],
    });

    expect(statusWriter.setRunStatus).toHaveBeenLastCalledWith("failed");
  });
});

// ---------------------------------------------------------------------------
// US-002: Run manifest retention during completion
//
// handleRunCompletion must invoke purgeStaleManifests when
// config.context.v2.manifest.retentionDays is configured, must not invoke it
// when the manifest block is unset, and must absorb any rejection as a
// warn-level log without failing the run.
// ---------------------------------------------------------------------------

describe("US-002: handleRunCompletion — manifest retention sweep", () => {
  type LogCall = [string, string, Record<string, unknown>];

  function makeCapturingLogger() {
    const infoCalls: LogCall[] = [];
    const warnCalls: LogCall[] = [];
    const logger = {
      info: (stage: string, msg: string, ctx: Record<string, unknown>) => infoCalls.push([stage, msg, ctx]),
      warn: (stage: string, msg: string, ctx: Record<string, unknown>) => warnCalls.push([stage, msg, ctx]),
      debug: () => {},
      error: () => {},
    };
    return { logger, infoCalls, warnCalls };
  }

  function makeConfigWithManifest(retentionDays?: number): NaxConfig {
    const base = makeConfig("disabled");
    if (retentionDays === undefined) return base;
    return makeNaxConfig({
      ...base,
      context: {
        ...base.context,
        v2: {
          ...base.context.v2,
          manifest: { retentionDays },
        },
      },
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: spy type varies by mock helper
  let loggerSpy: any;

  beforeEach(() => {
    // Force the regression gate off so we test the manifest branch in isolation.
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => ({
        success: true,
        failedTests: 0,
        failedTestFiles: [],
        passedTests: 0,
        rectificationAttempts: 0,
        affectedStories: [],
      }),
    );
    // Default mock: returns 0 deleted (so info branch is not hit unless AC5 asks).
    _runCompletionDeps.purgeStaleManifests = mock(
      async (_projectDir: string, _retentionDays: number) => 0,
    ) as typeof _runCompletionDeps.purgeStaleManifests;
  });

  afterEach(() => {
    Object.assign(_runCompletionDeps, {
      runDeferredRegression: mockRunDeferredRegression as typeof _runCompletionDeps.runDeferredRegression,
      purgeStaleManifests: undefined,
    });
    loggerSpy?.mockRestore();
    pipelineEventBus.clear();
    mock.restore();
  });

  test("AC1: invokes purgeStaleManifests exactly once with resolved projectDir and retentionDays when configured", async () => {
    const { logger } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root", { projectDir: "/project-root" }));

    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledTimes(1);
    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledWith("/project-root", 30);
  });

  test("AC1: falls back to workdir when projectDir is not provided", async () => {
    const { logger } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);
    const config = makeConfigWithManifest(14);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-only"));

    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledTimes(1);
    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledWith("/workdir-only", 14);
  });

  test("AC2: does not invoke purgeStaleManifests when context.v2.manifest is unset", async () => {
    const { logger } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);
    const config = makeConfigWithManifest(undefined);
    expect(config.context.v2.manifest).toBeUndefined();
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root", { projectDir: "/project-root" }));

    // The dep is wired (see beforeEach); it must NOT be invoked when the config is unset.
    expect(_runCompletionDeps.purgeStaleManifests).not.toHaveBeenCalled();
  });

  test("AC3: handleRunCompletion resolves with normal completion result when purgeStaleManifests rejects", async () => {
    const { logger } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);
    _runCompletionDeps.purgeStaleManifests = mock(async () => {
      throw new Error("disk full");
    }) as typeof _runCompletionDeps.purgeStaleManifests;
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    const result = await handleRunCompletion(makeOpts(config, prd, "/workdir-root"));

    // Must have actually called the dep — otherwise the test vacuously passes
    // when the implementation simply forgets to invoke the sweep.
    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledTimes(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.finalCounts.total).toBe(1);
    expect(result.finalCounts.passed).toBe(1);
    expect(typeof result.runCompletedAt).toBe("string");
    expect(typeof result.reportedTotal).toBe("number");
  });

  test("AC4: emits warn-level log when purgeStaleManifests rejects", async () => {
    const { logger, warnCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);
    _runCompletionDeps.purgeStaleManifests = mock(async () => {
      throw new Error("manifest sweep failed");
    }) as typeof _runCompletionDeps.purgeStaleManifests;
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root"));

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[0]).toBe("run.complete");
    expect(warnCalls[0]?.[1]).toMatch(/manifest/i);
    expect(warnCalls[0]?.[2].error).toBeDefined();
  });

  test("AC5: emits info-level log carrying the deleted count when purgeStaleManifests returns > 0", async () => {
    const { logger, infoCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);
    _runCompletionDeps.purgeStaleManifests = mock(async () => 7) as typeof _runCompletionDeps.purgeStaleManifests;
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root"));

    const manifestInfo = infoCalls.find(([stage, msg]) => stage === "run.complete" && /manifest/i.test(msg));
    expect(manifestInfo).toBeDefined();
    expect(manifestInfo?.[2].purged).toBe(7);
  });

  test("AC5 (boundary): does NOT emit info-level manifest log when purgeStaleManifests returns 0", async () => {
    const { logger, infoCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);
    _runCompletionDeps.purgeStaleManifests = mock(async () => 0) as typeof _runCompletionDeps.purgeStaleManifests;
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root"));

    const manifestInfo = infoCalls.find(([stage, msg]) => stage === "run.complete" && /manifest/i.test(msg));
    expect(manifestInfo).toBeUndefined();
  });
});
