/**
 * US-003: Enforce per-tier attempt budgets before dispatch — executor wiring.
 *
 * Acceptance criteria for the unified-executor side of the budget feature:
 *
 *   AC-9:  When the sequential executor dispatches a selected story, it invokes
 *         preIterationTierCheck once with that story BEFORE it invokes runIteration.
 *   AC-10: When the sequential executor receives shouldSkipIteration: true from
 *         preIterationTierCheck, it does NOT invoke runIteration for that story.
 *   AC-11: When the batch executor dispatches a batch, it invokes
 *         preIterationTierCheck once per batch story BEFORE the batch is
 *         dispatched.
 *
 * The executor seam is `_unifiedExecutorDeps.preIterationTierCheck` — the
 * implementer is expected to wire it up in the same place where
 * `_unifiedExecutorDeps.runIteration` is called, so tests can stub it without
 * `mock.module()`. Currently the deps object does not carry that key, so the
 * call from the source is impossible → tests fail with assertion failures, not
 * compile errors.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { executeUnified } from "@/execution/unified-executor";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePendingStory(id: string, overrides: Record<string, unknown> = {}) {
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
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    ...overrides,
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

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    prdPath: "/tmp/test-prd-tier-budget.json",
    workdir: "/tmp/test-workdir-tier-budget",
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
    runId: "run-tier-budget",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    runtime: {
      outputDir: "/tmp/nax-test-tier-budget-output",
      costAggregator: {
        snapshot: () => ({
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
        }),
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

/** Read a key from `_unifiedExecutorDeps` without TypeScript complaining that
 *  the key isn't on the interface. Tests can both read and write through
 *  this view. */
function depsView() {
  // Cast through `unknown` to access arbitrary keys — same pattern as the
  // dispatch/logging test files. The actual field is added by the
  // implementer; until then the read returns `undefined` and the write
  // installs a stub the source never calls.
  return require("../../../src/execution/unified-executor") as unknown as {
    // test-ratchet-allow: as-unknown-as
    _unifiedExecutorDeps: Record<string, unknown>;
    executeUnified: typeof executeUnified;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: sequential executor invokes preIterationTierCheck once before runIteration
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC-9: sequential executor invokes preIterationTierCheck once before runIteration", () => {
  let origPreIterationTierCheck: unknown;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = origPreIterationTierCheck;
    deps.runIteration = origRunIteration;
    deps.selectIndependentBatch = origSelectIndependentBatch;
    mock.restore();
  });

  test("preIterationTierCheck is called exactly once with the selected story, BEFORE runIteration fires", async () => {
    const story = makePendingStory("US-001");

    const callOrder: string[] = [];
    const preIterationTierCheckMock = mock(async (s: ReturnType<typeof makePendingStory>) => {
      callOrder.push(`preIterationTierCheck:${s.id}`);
      return { shouldSkipIteration: false, prdDirty: false, prd: makePrd([s]) };
    });
    const runIterationMock = mock(
      async (_ctx: unknown, _prd: unknown, selection: { story: ReturnType<typeof makePendingStory> }) => {
        callOrder.push(`runIteration:${selection.story.id}`);
        return {
          prd: makePrd([]),
          storiesCompletedDelta: 1,
          costDelta: 0,
          prdDirty: false,
        };
      },
    );

    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = preIterationTierCheckMock;
    deps.runIteration = runIterationMock;
    // Force the sequential path: parallelCount undefined, batch selector returns [].
    deps.selectIndependentBatch = mock(() => []);

    const prd = makePrd([story]);
    const ctx = makeCtx({ parallelCount: undefined });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    // AC-9: preIterationTierCheck is invoked exactly once with that story.
    expect(preIterationTierCheckMock).toHaveBeenCalledTimes(1);
    expect(preIterationTierCheckMock.mock.calls[0][0]?.id).toBe("US-001");

    // AC-9: preIterationTierCheck fires BEFORE runIteration.
    const preIdx = callOrder.findIndex((c) => c.startsWith("preIterationTierCheck:"));
    const runIdx = callOrder.findIndex((c) => c.startsWith("runIteration:"));
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(preIdx).toBeLessThan(runIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: shouldSkipIteration=true → runIteration is NOT invoked
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC-10: sequential executor skips runIteration when shouldSkipIteration=true", () => {
  let origPreIterationTierCheck: unknown;
  let origRunIteration: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    origRunIteration = deps.runIteration;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = origPreIterationTierCheck;
    deps.runIteration = origRunIteration;
    deps.selectIndependentBatch = origSelectIndependentBatch;
    mock.restore();
  });

  test("does not invoke runIteration when preIterationTierCheck returns shouldSkipIteration: true", async () => {
    const story = makePendingStory("US-001");

    const preIterationTierCheckMock = mock(async (s: ReturnType<typeof makePendingStory>) => {
      // Return skip; prdDirty=false so no loadPRD side-effect either.
      return { shouldSkipIteration: true, prdDirty: false, prd: makePrd([s]) };
    });
    const runIterationMock = mock(async () => {
      // Should never reach here on the AC-10 path.
      return {
        prd: makePrd([]),
        storiesCompletedDelta: 1,
        costDelta: 0,
        prdDirty: false,
      };
    });

    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = preIterationTierCheckMock;
    deps.runIteration = runIterationMock;
    deps.selectIndependentBatch = mock(() => []);

    const prd = makePrd([story]);
    const ctx = makeCtx({ parallelCount: undefined });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    // AC-10: preIterationTierCheck was consulted.
    expect(preIterationTierCheckMock).toHaveBeenCalledTimes(1);
    // AC-10: runIteration was NOT invoked for that story.
    expect(runIterationMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: batch executor invokes preIterationTierCheck once per batch story
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC-11: batch executor invokes preIterationTierCheck once per batch story", () => {
  let origPreIterationTierCheck: unknown;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = origPreIterationTierCheck;
    deps.runParallelBatch = origRunParallelBatch;
    deps.selectIndependentBatch = origSelectIndependentBatch;
    mock.restore();
  });

  test("preIterationTierCheck is called exactly once per batch story, all calls before runParallelBatch fires", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");
    const story3 = makePendingStory("US-003");

    const callOrder: string[] = [];
    const preIterationTierCheckMock = mock(async (s: ReturnType<typeof makePendingStory>) => {
      callOrder.push(`preIterationTierCheck:${s.id}`);
      return { shouldSkipIteration: false, prdDirty: false, prd: makePrd([s]) };
    });
    const runParallelBatchMock = mock(async () => {
      callOrder.push("runParallelBatch");
      return {
        completed: [story1, story2, story3],
        failed: [],
        mergeConflicts: [],
        storyCosts: new Map([
          [story1.id, 0],
          [story2.id, 0],
          [story3.id, 0],
        ]),
        totalCost: 0,
      };
    });

    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = preIterationTierCheckMock;
    deps.runParallelBatch = runParallelBatchMock;
    deps.selectIndependentBatch = mock(() => [story1, story2, story3]);

    const prd = makePrd([story1, story2, story3]);
    const ctx = makeCtx({ parallelCount: 3 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    // AC-11: one call per batch story (3 stories → 3 calls).
    expect(preIterationTierCheckMock).toHaveBeenCalledTimes(3);
    const calledIds = preIterationTierCheckMock.mock.calls.map((c) => (c[0] as { id: string })?.id);
    expect(calledIds).toContain("US-001");
    expect(calledIds).toContain("US-002");
    expect(calledIds).toContain("US-003");

    // AC-11: every preIterationTierCheck call happens BEFORE runParallelBatch.
    const batchIdx = callOrder.indexOf("runParallelBatch");
    expect(batchIdx).toBeGreaterThan(0);
    const preCallIdxs = callOrder
      .map((c, i) => (c.startsWith("preIterationTierCheck:") ? i : -1))
      .filter((i) => i >= 0);
    expect(preCallIdxs.length).toBe(3);
    for (const idx of preCallIdxs) {
      expect(idx).toBeLessThan(batchIdx);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quality-review follow-up: a batch story preIterationTierCheck marks
// shouldSkipIteration must not also be dispatched to runParallelBatch — the
// sequential and single-story paths already `continue` on shouldSkipIteration;
// batch mode previously computed the skip and discarded it.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003: batch executor excludes shouldSkipIteration stories from dispatch", () => {
  let origPreIterationTierCheck: unknown;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    origPreIterationTierCheck = deps.preIterationTierCheck;
    origRunParallelBatch = deps.runParallelBatch;
    origSelectIndependentBatch = deps.selectIndependentBatch;
  });

  afterEach(() => {
    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = origPreIterationTierCheck;
    deps.runParallelBatch = origRunParallelBatch;
    deps.selectIndependentBatch = origSelectIndependentBatch;
    mock.restore();
  });

  test("a story whose pre-check returns shouldSkipIteration is excluded from runParallelBatch's stories", async () => {
    const story1 = makePendingStory("US-101");
    const story2 = makePendingStory("US-102"); // this one exhausts its budget
    const story3 = makePendingStory("US-103");

    const preIterationTierCheckMock = mock(async (s: ReturnType<typeof makePendingStory>) => {
      if (s.id === "US-102") {
        return { shouldSkipIteration: true, prdDirty: true, prd: makePrd([story1, story2, story3]) };
      }
      return { shouldSkipIteration: false, prdDirty: false, prd: makePrd([story1, story2, story3]) };
    });
    const runParallelBatchMock = mock(async (opts: { stories: Array<{ id: string }> }) => {
      return {
        completed: opts.stories,
        failed: [],
        mergeConflicts: [],
        storyCosts: new Map(opts.stories.map((s) => [s.id, 0])),
        totalCost: 0,
      };
    });

    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = preIterationTierCheckMock;
    deps.runParallelBatch = runParallelBatchMock;
    deps.selectIndependentBatch = mock(() => [story1, story2, story3]);

    const prd = makePrd([story1, story2, story3]);
    const ctx = makeCtx({ parallelCount: 3 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(runParallelBatchMock).toHaveBeenCalledTimes(1);
    const dispatchedIds = (runParallelBatchMock.mock.calls[0]?.[0] as { stories: Array<{ id: string }> }).stories.map(
      (s) => s.id,
    );
    expect(dispatchedIds).toContain("US-101");
    expect(dispatchedIds).toContain("US-103");
    expect(dispatchedIds).not.toContain("US-102");
  });

  test("when every batch story is skipped, runParallelBatch is never called", async () => {
    const story1 = makePendingStory("US-201");
    const story2 = makePendingStory("US-202");

    const preIterationTierCheckMock = mock(async () => ({
      shouldSkipIteration: true,
      prdDirty: true,
      prd: makePrd([story1, story2]),
    }));
    const runParallelBatchMock = mock(async () => ({
      completed: [],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map(),
      totalCost: 0,
    }));

    const deps = depsView()._unifiedExecutorDeps;
    deps.preIterationTierCheck = preIterationTierCheckMock;
    deps.runParallelBatch = runParallelBatchMock;
    deps.selectIndependentBatch = mock(() => [story1, story2]);

    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    await executeUnified(ctx as never, prd as never).catch(() => {});

    expect(runParallelBatchMock).not.toHaveBeenCalled();
  });
});
