/**
 * Unit tests for US-003: Unify executors — story.start logging
 *
 * File: unified-executor-logging.test.ts
 * Covers:
 *   story.start logging — parallel batch dispatch
 *   story.start logging — sequential (single-story) dispatch
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as loggerModule from "../../../src/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePendingStory(id: string) {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    attempts: 0,
    priorFailures: [],
  };
}

function makePrd(stories: ReturnType<typeof makePendingStory>[]) {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(overrides: { parallelCount?: number } = {}) {
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {
      execution: {
        maxIterations: 1,
        costLimit: 10,
        iterationDelayMs: 0,
        rectification: { maxRetries: 2 },
      },
      autoMode: { defaultAgent: "claude-code" },
      interaction: {},
    },
    hooks: {},
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: {
      getReporters: () => [],
      getContextProviders: () => [],
    },
    statusWriter: {
      setPrd: mock(() => {}),
      setCurrentStory: mock(() => {}),
      setRunStatus: mock(() => {}),
      update: mock(async () => {}),
    },
    runId: "run-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    runtime: {
      outputDir: "/tmp/nax-test-logging-output",
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
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// story.start logging — parallel batch dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start logging — parallel batch dispatch", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;
  let loggerSpy: ReturnType<typeof spyOn>;

  interface LogCall {
    stage: string;
    message: string;
    data?: Record<string, unknown>;
  }

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    loggerSpy?.mockRestore();
    mock.restore();
  });

  test("logger.info is called with stage 'story.start' for each story in a parallel batch", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    const infoCalls: LogCall[] = [];
    const logger = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as ReturnType<typeof loggerModule.getSafeLogger>);

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([[story1.id, 0], [story2.id, 0]]),
      totalCost: 0,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const storyStartCalls = infoCalls.filter((c) => c.stage === "story.start");
    expect(storyStartCalls.length).toBeGreaterThanOrEqual(2);

    const ids = storyStartCalls.map((c) => c.data?.storyId);
    expect(ids).toContain("US-001");
    expect(ids).toContain("US-002");
  });

  test("story.start log data includes storyId, storyTitle, complexity, modelTier, attempt for batch stories", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as ReturnType<typeof loggerModule.getSafeLogger>);

    deps.selectIndependentBatch = mock(() => [story1, makePendingStory("US-002")]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([[story1.id, 0]]),
      totalCost: 0,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, makePendingStory("US-002")]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const call = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call).toBeDefined();
    expect(call?.data).toMatchObject({
      storyId: "US-001",
      storyTitle: "Story US-001",
      attempt: 1,
    });
    expect(call?.data).toHaveProperty("complexity");
    expect(call?.data).toHaveProperty("modelTier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// story.start logging — sequential (single-story) dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("story.start logging — sequential (single-story) dispatch", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;
  let loggerSpy: ReturnType<typeof spyOn>;

  interface LogCall {
    stage: string;
    message: string;
    data?: Record<string, unknown>;
  }

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    loggerSpy?.mockRestore();
    mock.restore();
  });

  test("logger.info is called with stage 'story.start' for a single-story sequential dispatch", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as ReturnType<typeof loggerModule.getSafeLogger>);

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const storyStartCalls = infoCalls.filter((c) => c.stage === "story.start");
    expect(storyStartCalls.length).toBeGreaterThanOrEqual(1);
    expect(storyStartCalls[0].data?.storyId).toBe("US-001");
  });

  test("story.start log data includes storyId, storyTitle, complexity, modelTier, attempt for sequential dispatch", async () => {
    const story1 = makePendingStory("US-001");

    const infoCalls: LogCall[] = [];
    const logger = {
      info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
        infoCalls.push({ stage, message, data });
      }),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as ReturnType<typeof loggerModule.getSafeLogger>);

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    const call = infoCalls.find((c) => c.stage === "story.start" && c.data?.storyId === "US-001");
    expect(call).toBeDefined();
    expect(call?.data).toMatchObject({
      storyId: "US-001",
      storyTitle: "Story US-001",
      attempt: 1,
    });
    expect(call?.data).toHaveProperty("complexity");
    expect(call?.data).toHaveProperty("modelTier");
  });
});
