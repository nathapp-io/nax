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
        rectification: { maxAttemptsTotal: 2 },
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
      outputDir: "/tmp/nax-test-dispatch-output",
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
  let origPreIterationTierCheck: unknown;

  beforeEach(async () => {
    const mod = await import("../../../src/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origRunIteration = deps.runIteration;
    origPreIterationTierCheck = deps.preIterationTierCheck;
  });

  afterEach(() => {
    if (deps) {
      deps.runIteration = origRunIteration;
      deps.preIterationTierCheck = origPreIterationTierCheck;
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

  test("BUG-39: a transiently failed story is retried before other ready work, under useBatch:true", async () => {
    // Before the underlying fix, two separate gaps combined to make a
    // transient failure terminal under useBatch:true:
    //  1. lastStoryId was only ever set when !ctx.useBatch, so getNextStory's
    //     retry-priority branch never even had a candidate to check.
    //  2. Even with lastStoryId correctly tracked, selectNextStories's
    //     batch-plan branch only consulted it via the single-story fallback
    //     (reached when the current batch slot is empty) — with another ready
    //     story competing (US-001 here), the batch-plan branch would just
    //     pick that other story every time, never retrying US-000.
    // This test needs a second, unrelated, always-ready story so the batch
    // plan is never empty after US-000 fails — proving the fix wins retry
    // priority over competing work, not just over an empty batch plan.
    const us000 = {
      ...makePendingStory("US-000"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us001 = {
      ...makePendingStory("US-001"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const initialPrd = makePrd([us000, us001]);
    const selectedStoryIds: string[] = [];
    const callsPerStory: Record<string, number> = {};

    deps.runIteration = mock(async (_ctx: unknown, prdArg: typeof initialPrd, selection: { story: { id: string } }) => {
      selectedStoryIds.push(selection.story.id);
      callsPerStory[selection.story.id] = (callsPerStory[selection.story.id] ?? 0) + 1;
      // US-000 fails on its first dispatch, then passes on retry. US-001
      // always passes on its first (only) dispatch.
      const failsThisCall = selection.story.id === "US-000" && callsPerStory[selection.story.id] === 1;
      const nextPrd = {
        ...prdArg,
        userStories: prdArg.userStories.map((story) =>
          story.id === selection.story.id
            ? failsThisCall
              ? { ...story, status: "failed" as const, attempts: story.attempts + 1 }
              : { ...story, status: "passed" as const, passes: true }
            : story,
        ),
      };
      return {
        prd: nextPrd,
        storiesCompletedDelta: failsThisCall ? 0 : 1,
        costDelta: 0,
        prdDirty: false,
      };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const baseCtx = makeCtx();
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, maxIterations: 3 },
      },
      useBatch: true,
      batchPlan: precomputeBatchPlan([us000, us001], 4),
    };

    await executeUnified(ctx as never, initialPrd as never);

    // US-000 retried immediately after failing — before US-001 ever runs.
    expect(selectedStoryIds).toEqual(["US-000", "US-000", "US-001"]);
  });

  test("BUG-39: a story that exhausts its tier ladder stops winning retry priority (no starvation)", async () => {
    // A first pass at this fix retried lastStoryId unconditionally whenever it
    // was still resumable per getNextStory — but preIterationTierCheck (real,
    // unmocked in production) marks a tier-exhausted story permanently
    // "failed" via markStoryFailed, which getNextStory's own retry check also
    // treats as resumable (status "failed", attempts <= maxAttemptsTotal).
    // Without clearing lastStoryId once a story goes terminal, retry-priority
    // would keep re-selecting it every iteration — preIterationTierCheck skips
    // it again every time, dispatching nothing and starving every other story
    // in the PRD until maxIterations/maxAttemptsTotal is exhausted.
    const us000 = {
      ...makePendingStory("US-000"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us001 = {
      ...makePendingStory("US-001"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const initialPrd = makePrd([us000, us001]);
    const selectedStoryIds: string[] = [];
    let tierCheckCallsForUs000 = 0;

    // US-000 always fails its (mocked) dispatch; US-001 always passes. This
    // makes US-000 retry-eligible after its first attempt, so retry-priority
    // re-selects it — at which point the preIterationTierCheck mock below
    // simulates the tier ladder being exhausted on that second check.
    deps.runIteration = mock(async (_ctx: unknown, prdArg: typeof initialPrd, selection: { story: { id: string } }) => {
      selectedStoryIds.push(selection.story.id);
      const nextPrd = {
        ...prdArg,
        userStories: prdArg.userStories.map((story) =>
          story.id === selection.story.id
            ? story.id === "US-000"
              ? { ...story, status: "failed" as const, attempts: story.attempts + 1 }
              : { ...story, status: "passed" as const, passes: true }
            : story,
        ),
      };
      return { prd: nextPrd, storiesCompletedDelta: selection.story.id === "US-000" ? 0 : 1, costDelta: 0, prdDirty: false };
    });

    deps.preIterationTierCheck = mock(async (story: { id: string }, _routing: unknown, _config: unknown, prd: typeof initialPrd) => {
      if (story.id !== "US-000") {
        return { shouldSkipIteration: false, prdDirty: false, prd };
      }
      tierCheckCallsForUs000++;
      // First check (before US-000 has failed yet): still has budget, proceed.
      if (tierCheckCallsForUs000 === 1) {
        return { shouldSkipIteration: false, prdDirty: false, prd };
      }
      // Second check (the retry attempt, after US-000 already failed once):
      // tier ladder exhausted — markStoryFailed's real effect, status stays
      // "failed" and the run must move on instead of retrying forever.
      // prdDirty:false (unlike production, which saves to real disk and
      // reloads) — prd already carries the failed status from the runIteration
      // mock above, so no reload is needed here.
      return { shouldSkipIteration: true, prdDirty: false, prd };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const baseCtx = makeCtx();
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, maxIterations: 3 },
      },
      useBatch: true,
      batchPlan: precomputeBatchPlan([us000, us001], 4),
    };

    await executeUnified(ctx as never, initialPrd as never);

    // US-000 dispatched once (fails), retried once more (goes terminal via
    // preIterationTierCheck, never reaching runIteration again) — US-001 must
    // still get a turn instead of the run spinning on US-000 until maxIterations.
    expect(selectedStoryIds).toEqual(["US-000", "US-001"]);
  });

  test("BUG-39: a failed story is retried before other ready work under --parallel (batch.length===1)", async () => {
    // The batch.length===1 dispatch branch (parallelCount > 0, exactly one
    // independent story) never consulted selectNextStories/lastStoryId at
    // all — it dispatched whatever selectIndependentBatch returned, which
    // excludes "failed" stories outright. Unconditionally tracking
    // lastStoryId there was a real improvement (retry works once the failed
    // story is the ONLY remaining work) but did not fix the case where a
    // competing story is still ready: selectIndependentBatch would just pick
    // that other story and overwrite lastStoryId, never returning to retry
    // the failed one. resolveRetryCandidate must pre-empt
    // selectIndependentBatch here too, exactly as it does for the
    // batch-plan-active path in selectNextStories.
    const us000 = {
      ...makePendingStory("US-000"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const us001 = {
      ...makePendingStory("US-001"),
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "simple" },
    };
    const initialPrd = makePrd([us000, us001]);
    const selectedStoryIds: string[] = [];
    const callsPerStory: Record<string, number> = {};

    deps.runIteration = mock(async (_ctx: unknown, prdArg: typeof initialPrd, selection: { story: { id: string } }) => {
      selectedStoryIds.push(selection.story.id);
      callsPerStory[selection.story.id] = (callsPerStory[selection.story.id] ?? 0) + 1;
      const failsThisCall = selection.story.id === "US-000" && callsPerStory[selection.story.id] === 1;
      const nextPrd = {
        ...prdArg,
        userStories: prdArg.userStories.map((story) =>
          story.id === selection.story.id
            ? failsThisCall
              ? { ...story, status: "failed" as const, attempts: story.attempts + 1 }
              : { ...story, status: "passed" as const, passes: true }
            : story,
        ),
      };
      return { prd: nextPrd, storiesCompletedDelta: failsThisCall ? 0 : 1, costDelta: 0, prdDirty: false };
    });

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const baseCtx = makeCtx();
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: { ...baseCtx.config.execution, maxIterations: 3 },
      },
      parallelCount: 1,
      useBatch: false,
      batchPlan: [],
    };

    await executeUnified(ctx as never, initialPrd as never);

    expect(selectedStoryIds).toEqual(["US-000", "US-000", "US-001"]);
  });
});
