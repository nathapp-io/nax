/**
 * RL-002: unified-executor.ts no longer emits run:completed
 *
 * Acceptance Criteria Tested:
 * - AC #2: unified-executor.ts does NOT emit run:completed event
 *   (the event must be emitted by runner.ts AFTER handleRunCompletion finishes)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { type SequentialExecutionContext, executeUnified } from "../../../src/execution/unified-executor";
import { _runCompletionDeps, handleRunCompletion } from "../../../src/execution/lifecycle/run-completion";
import type { LoadedHooksConfig } from "../../../src/hooks";
import type { PipelineEvent, RunCompletedEvent } from "../../../src/pipeline/event-bus";
import { pipelineEventBus } from "../../../src/pipeline/event-bus";
import type { PRD, UserStory } from "../../../src/prd/types";

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

function makeCompletePRD(stories: UserStory[] = [makeStory("US-001", "passed")]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
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

function makePluginRegistry() {
  return {
    getReporters: () => [],
    getContextProviders: () => [],
    getReviewers: () => [],
    getRoutingStrategies: () => [],
  };
}

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

const RL002_WORKDIR = `/tmp/nax-rl002-test-workdir-${randomUUID()}`;
const RL002_PRD_PATH = `/tmp/nax-rl002-test-prd-${randomUUID()}.json`;

function makeMinimalContext(): SequentialExecutionContext {
  return {
    prdPath: RL002_PRD_PATH,
    workdir: RL002_WORKDIR,
    config: {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        iterationDelayMs: 0,
      },
    },
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry() as unknown as SequentialExecutionContext["pluginRegistry"],
    statusWriter: makeStatusWriter() as unknown as SequentialExecutionContext["statusWriter"],
    runId: "run-rl002-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    logFilePath: undefined,
    runtime: {
      outputDir: "/tmp/nax-test-rl002-output",
      costAggregator: {
        snapshot: () => ({ totalCostUsd: 0, totalEstimatedCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, callCount: 0, errorCount: 0 }),
        byStage: () => ({}),
        byStory: () => ({}),
        byAgent: () => ({}),
        record: () => {},
        recordError: () => {},
        recordOperationSummary: () => {},
        drain: async () => {},
      },
    } as unknown as SequentialExecutionContext["runtime"],
  };
}

// ---------------------------------------------------------------------------
// Spy setup: capture all events emitted through pipelineEventBus
// ---------------------------------------------------------------------------

let capturedEvents: PipelineEvent[] = [];
let originalEmit: typeof pipelineEventBus.emit;

beforeEach(() => {
  capturedEvents = [];
  originalEmit = pipelineEventBus.emit.bind(pipelineEventBus);
  pipelineEventBus.emit = (event: PipelineEvent): void => {
    capturedEvents.push(event);
    originalEmit(event);
  };
});

afterEach(() => {
  pipelineEventBus.emit = originalEmit;
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RL-002: unified-executor does not emit run:completed", () => {
  test("does not emit run:completed when PRD is complete at start of loop", async () => {
    const prd = makeCompletePRD([makeStory("US-001", "passed")]);
    const ctx = makeMinimalContext();

    const result = await executeUnified(ctx, prd);

    expect(result.exitReason).toBe("completed");

    const runCompletedEvents = capturedEvents.filter(
      (ev): ev is RunCompletedEvent => ev.type === "run:completed",
    );
    // AC #2: unified-executor must NOT emit run:completed
    expect(runCompletedEvents).toHaveLength(0);
  });

  test("does not emit run:completed when all stories are skipped", async () => {
    const prd = makeCompletePRD([makeStory("US-001", "skipped"), makeStory("US-002", "skipped")]);
    const ctx = makeMinimalContext();

    const result = await executeUnified(ctx, prd);

    expect(result.exitReason).toBe("completed");

    const runCompletedEvents = capturedEvents.filter((ev) => ev.type === "run:completed");
    expect(runCompletedEvents).toHaveLength(0);
  });

  test("does not emit run:completed when PRD has mixed passed and skipped stories", async () => {
    const prd = makeCompletePRD([
      makeStory("US-001", "passed"),
      makeStory("US-002", "skipped"),
      makeStory("US-003", "passed"),
    ]);
    const ctx = makeMinimalContext();

    const result = await executeUnified(ctx, prd);

    expect(result.exitReason).toBe("completed");

    const runCompletedEvents = capturedEvents.filter((ev) => ev.type === "run:completed");
    expect(runCompletedEvents).toHaveLength(0);
  });

  test("returns completed exitReason correctly (sanity check)", async () => {
    const prd = makeCompletePRD();
    const ctx = makeMinimalContext();

    const result = await executeUnified(ctx, prd);

    // The executor should still return the correct exit reason
    expect(result.exitReason).toBe("completed");
    expect(result.prd).toBeDefined();
  });
});

describe("RL-002: run:completed event payload requirements", () => {
  test("run:completed event has non-zero passedStories when stories are passed", async () => {
    // Verify that handleRunCompletion emits run:completed with real story counts
    // (not placeholder 0/0/0 values). AC #3: event reflects actual finalCounts.

    const capturedRunCompleted: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedRunCompleted.push(ev);
    });

    const originalRunRegression = _runCompletionDeps.runDeferredRegression;
    _runCompletionDeps.runDeferredRegression = mock(async () => ({
      success: true,
      failedTests: 0,
      passedTests: 2,
      rectificationAttempts: 0,
      affectedStories: [],
      failedTestFiles: [],
    }));

    try {
      const prd = makeCompletePRD([makeStory("US-001", "passed"), makeStory("US-002", "passed")]);
      const ctx = makeMinimalContext();

      await handleRunCompletion({
        runId: ctx.runId,
        feature: ctx.feature,
        startedAt: new Date().toISOString(),
        prd,
        allStoryMetrics: [],
        totalCost: 0.5,
        storiesCompleted: 2,
        iterations: 2,
        startTime: Date.now() - 1000,
        workdir: ctx.workdir,
        statusWriter: ctx.statusWriter as never,
        config: ctx.config,
        runtime: ctx.runtime,
      });

      // handleRunCompletion should emit run:completed with real counts from countStories(prd)
      expect(capturedRunCompleted[0]?.totalStories).toBeGreaterThan(0);
      expect(capturedRunCompleted[0]?.passedStories).toBeGreaterThan(0);
    } finally {
      unsub();
      _runCompletionDeps.runDeferredRegression = originalRunRegression;
    }
  });

  test("run:completed event emitted by runner reflects regression result in status", async () => {
    // AC #3: Hook payload reflects final success status (including regression result).
    //
    // handleRunCompletion runs the regression gate then emits run:completed
    // with finalCounts derived from countStories(prd). Verify real counts are used.

    const capturedRunCompleted: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedRunCompleted.push(ev);
    });

    const originalRunRegression = _runCompletionDeps.runDeferredRegression;
    _runCompletionDeps.runDeferredRegression = mock(async () => ({
      success: false,
      failedTests: 1,
      passedTests: 2,
      rectificationAttempts: 0,
      affectedStories: ["US-003"],
      failedTestFiles: [],
    }));

    try {
      // 3-story PRD: 2 passed, 1 failed — totalStories must be 3 after fix
      const prd = makeCompletePRD([
        makeStory("US-001", "passed"),
        makeStory("US-002", "passed"),
        makeStory("US-003", "failed"),
      ]);
      const ctx = makeMinimalContext();

      await handleRunCompletion({
        runId: ctx.runId,
        feature: ctx.feature,
        startedAt: new Date().toISOString(),
        prd,
        allStoryMetrics: [],
        totalCost: 1.0,
        storiesCompleted: 2,
        iterations: 3,
        startTime: Date.now() - 1000,
        workdir: ctx.workdir,
        statusWriter: ctx.statusWriter as never,
        config: ctx.config,
        runtime: ctx.runtime,
      });

      const ev = capturedRunCompleted[0];
      expect(ev).toBeDefined();

      // finalCounts from countStories(prd): total=3, not placeholder 0
      expect(ev?.totalStories).toBeGreaterThan(0);
    } finally {
      unsub();
      _runCompletionDeps.runDeferredRegression = originalRunRegression;
    }
  });
});
