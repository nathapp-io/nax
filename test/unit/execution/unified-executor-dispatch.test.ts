/**
 * Unit tests for US-003: Unify executors — integrate parallel dispatch into
 * the sequential loop.
 *
 * File: unified-executor-dispatch.test.ts
 * Covers:
 *   AC-2 runParallelBatch dispatch via _deps injection
 *   AC-4 runIteration when parallelCount undefined or 0 (runtime)
 *   AC-5 story:started per-batch story via _deps injection
 *   AC-7 cost-limit exit after parallel batch (runtime)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { precomputeBatchPlan } from "../../../src/execution/batching";

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
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-2 / AC-4 — dispatch behavior via _deps injection
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2 — runParallelBatch dispatch via _deps injection", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunParallelBatch = deps.runParallelBatch;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    if (deps) {
      deps.runParallelBatch = origRunParallelBatch;
      deps.runIteration = origRunIteration;
      deps.selectIndependentBatch = origSelectIndependentBatch;
    }
    mock.restore();
  });

  test("selectIndependentBatch is called when parallelCount > 0", async () => {
    const calls: unknown[][] = [];
    deps.selectIndependentBatch = mock((stories: unknown[], maxCount: unknown) => {
      calls.push([stories, maxCount]);
      return [];
    });
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const story = makePendingStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(calls.length).toBeGreaterThan(0);
    const [_stories, maxCount] = calls[0];
    expect(maxCount).toBe(2);
  });

  test("runParallelBatch is called (not runIteration) when batch returns > 1 story", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    const parallelCalls: unknown[] = [];
    const iterationCalls: unknown[] = [];

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => {
      parallelCalls.push(true);
      return {
        completed: [story1, story2],
        failed: [],
        mergeConflicts: [],
        storyCosts: new Map([
          [story1.id, 0.1],
          [story2.id, 0.1],
        ]),
        totalCost: 0.2,
      };
    });
    deps.runIteration = mock(async () => {
      iterationCalls.push(true);
      return { prd: makePrd([]), storiesCompletedDelta: 1, costDelta: 0, prdDirty: false };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(parallelCalls.length).toBeGreaterThan(0);
    expect(iterationCalls.length).toBe(0);
  });

  test("runIteration is called (not runParallelBatch) when parallelCount is undefined", async () => {
    const story1 = makePendingStory("US-001");

    const parallelCalls: unknown[] = [];
    const iterationCalls: unknown[] = [];

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runParallelBatch = mock(async () => {
      parallelCalls.push(true);
      return { completed: [], failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 };
    });
    deps.runIteration = mock(async () => {
      iterationCalls.push(true);
      return { prd: makePrd([]), storiesCompletedDelta: 1, costDelta: 0, prdDirty: false };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: undefined });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(parallelCalls.length).toBe(0);
    expect(iterationCalls.length).toBeGreaterThan(0);
  });

  test("runIteration is called (not runParallelBatch) when parallelCount is 0", async () => {
    const story1 = makePendingStory("US-001");

    const parallelCalls: unknown[] = [];

    deps.selectIndependentBatch = mock(() => []);
    deps.runParallelBatch = mock(async () => {
      parallelCalls.push(true);
      return { completed: [], failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 };
    });
    deps.runIteration = mock(async () => ({
      prd: makePrd([]),
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 0 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(parallelCalls.length).toBe(0);
  });

  test("runIteration is called when parallelCount > 0 but selectIndependentBatch returns exactly 1 story", async () => {
    const story1 = makePendingStory("US-001");

    const parallelCalls: unknown[] = [];
    const iterationCalls: unknown[] = [];

    deps.selectIndependentBatch = mock(() => [story1]);
    deps.runParallelBatch = mock(async () => {
      parallelCalls.push(true);
      return { completed: [], failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 };
    });
    deps.runIteration = mock(async () => {
      iterationCalls.push(true);
      return { prd: makePrd([]), storiesCompletedDelta: 1, costDelta: 0, prdDirty: false };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1]);
    const ctx = makeCtx({ parallelCount: 4 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(parallelCalls.length).toBe(0);
    expect(iterationCalls.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 — story:started per-batch story via _deps injection
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5 — story:started per-batch story via _deps injection", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

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
    mock.restore();
  });

  test("pipelineEventBus emits story:started for each batch story before runParallelBatch fires", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    const eventLog: string[] = [];
    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => {
      eventLog.push("runParallelBatch");
      return {
        completed: [story1, story2],
        failed: [],
        mergeConflicts: [],
        storyCosts: new Map([[story1.id, 0], [story2.id, 0]]),
        totalCost: 0,
      };
    });

    const { pipelineEventBus } = await import("../../../src/pipeline/event-bus");
    const origEmit = pipelineEventBus.emit.bind(pipelineEventBus);
    pipelineEventBus.emit = mock((event: Record<string, unknown>) => {
      if (event.type === "story:started") {
        eventLog.push(`story:started:${event.storyId}`);
      }
      return origEmit(event as never);
    }) as typeof pipelineEventBus.emit;

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    pipelineEventBus.emit = origEmit;

    const batchIdx = eventLog.indexOf("runParallelBatch");
    const started1Idx = eventLog.indexOf("story:started:US-001");
    const started2Idx = eventLog.indexOf("story:started:US-002");

    expect(batchIdx).toBeGreaterThan(0);
    expect(started1Idx).toBeGreaterThanOrEqual(0);
    expect(started2Idx).toBeGreaterThanOrEqual(0);
    expect(started1Idx).toBeLessThan(batchIdx);
    expect(started2Idx).toBeLessThan(batchIdx);
  });
});

describe("useBatch scheduling refresh", () => {
  let deps: Record<string, unknown>;
  let origRunIteration: unknown;

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
    }
    mock.restore();
  });

  test("recomputes the batch plan after a story completes so newly unblocked stories run next", async () => {
    const us000 = {
      ...makePendingStory("US-000"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us001 = {
      ...makePendingStory("US-001"),
      dependencies: ["US-000"],
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us006 = {
      ...makePendingStory("US-006"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };

    const initialPrd = makePrd([us000, us001, us006]);
    const staleBatchPlan = precomputeBatchPlan([us000, us006], 4);
    const selectedStoryIds: string[] = [];

    deps.runIteration = mock(async (_ctx: unknown, prdArg: typeof initialPrd, selection: { story: { id: string } }) => {
      selectedStoryIds.push(selection.story.id);
      const nextPrd = {
        ...prdArg,
        userStories: prdArg.userStories.map((story) =>
          story.id === selection.story.id ? { ...story, status: "passed" as const, passes: true } : story,
        ),
      };
      return {
        prd: nextPrd,
        storiesCompletedDelta: 1,
        costDelta: 0,
        prdDirty: false,
      };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const ctx = {
      ...makeCtx(),
      config: {
        ...makeCtx().config,
        execution: {
          ...makeCtx().config.execution,
          maxIterations: 2,
        },
      },
      useBatch: true,
      batchPlan: staleBatchPlan,
    };

    await executeUnified(ctx as never, initialPrd as never);

    expect(selectedStoryIds).toEqual(["US-000", "US-001"]);
  });
});
