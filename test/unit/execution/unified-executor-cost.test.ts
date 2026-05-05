/**
 * Unit tests for US-003: Unify executors — cost-limit exit after parallel batch.
 *
 * File: unified-executor-cost.test.ts
 * Covers:
 *   AC-7 cost-limit exit after parallel batch (runtime)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
      outputDir: "/tmp/nax-test-cost-output",
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
// AC-7 — cost-limit exit after parallel batch (runtime)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7 — cost-limit exit after parallel batch (runtime)", () => {
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

  test("executeUnified returns exitReason 'cost-limit' when parallel batch pushes totalCost over the configured limit", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 3],
        [story2.id, 3],
      ]),
      totalCost: 6,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: {
          ...baseCtx.config.execution,
          costLimit: 5,
          maxIterations: 2,
        },
      },
    };

    const result = await executeUnified(ctx as never, prd as never);
    expect(result.exitReason).toBe("cost-limit");
    expect(result.totalCost).toBeGreaterThanOrEqual(6);
  });

  test("executeUnified does NOT exit with cost-limit when parallel batch cost stays below limit", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map<string, number>([
        [story1.id, 1],
        [story2.id, 1],
      ]),
      totalCost: 2,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const baseCtx = makeCtx({ parallelCount: 2 });
    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        execution: {
          ...baseCtx.config.execution,
          costLimit: 100,
          maxIterations: 1,
        },
      },
    };

    const result = await executeUnified(ctx as never, prd as never).catch(
      () => ({ exitReason: "error" }) as { exitReason: string },
    );
    expect(result.exitReason).not.toBe("cost-limit");
  });
});
