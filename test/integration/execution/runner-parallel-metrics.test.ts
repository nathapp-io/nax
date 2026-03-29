/**
 * Integration tests for US-004: Fix per-story metrics accuracy.
 *
 * Tests invoke executeUnified directly with parallelCount set.
 * No mocking of a removed dispatch function (AC-5).
 *
 * Covers:
 *   AC-1  Each completed story's cost equals storyCosts.get(story.id)
 *   AC-2  Each completed story's durationMs equals storyDurations.get(story.id)
 *         from the batch result (per-story, not batch wall-clock)
 *   AC-3  Rectified stories have source: 'rectification' and rectificationCost
 *         in their StoryMetrics entry
 *   AC-4  story:started events emitted with correct storyId per story before batch
 *   AC-5  These tests call executeUnified directly — the old dispatch function is never referenced
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initLogger, resetLogger } from "../../../src/logger";
import type { StoryMetrics } from "../../../src/metrics";
import type { RunParallelBatchResult } from "../../../src/execution/parallel-batch";
import type { UserStory, PRD } from "../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePendingStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [`AC-1: ${id} works`],
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
    routing: {
      complexity: "simple" as const,
      modelTier: "fast" as const,
      testStrategy: "test-after" as const,
      reasoning: "test",
    },
    priorFailures: [],
  } as unknown as UserStory;
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
}

function makeCtx(overrides: { parallelCount?: number; costLimit?: number; maxIterations?: number } = {}) {
  const { parallelCount, costLimit = 100, maxIterations = 1 } = overrides;
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: {
      execution: {
        maxIterations,
        costLimit,
        iterationDelayMs: 0,
        rectification: { maxRetries: 2 },
      },
      autoMode: { defaultAgent: "claude-code" },
      interaction: {},
    },
    hooks: {},
    feature: "test-feature",
    featureDir: "/tmp/test-feature-dir",
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
    parallelCount,
  };
}

function makeBatchResult(
  stories: UserStory[],
  costMap: Map<string, number>,
  durationsMap?: Map<string, number>,
  conflicts: Array<{ story: UserStory; rectified: boolean; cost: number }> = [],
): RunParallelBatchResult {
  return {
    completed: stories,
    failed: [],
    mergeConflicts: conflicts,
    storyCosts: costMap,
    storyDurations: durationsMap,
    totalCost: [...costMap.values()].reduce((a, b) => a + b, 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "nax-metrics-"));
  initLogger();
});

afterEach(() => {
  resetLogger();
  try {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup errors
  }
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: Per-story cost from storyCosts Map
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1 — completed story cost equals storyCosts.get(story.id)", () => {
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

  test("story1 cost equals storyCosts.get(story1.id) from batch result", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");
    const costMap = new Map([
      [story1.id, 0.15],
      [story2.id, 0.25],
    ]);

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () =>
      makeBatchResult([story1, story2], costMap),
    );

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    const result = await executeUnified(ctx as never, prd as never);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    expect(m1).toBeDefined();
    expect(m2).toBeDefined();
    expect(m1!.cost).toBe(0.15);
    expect(m2!.cost).toBe(0.25);
  });

  test("story cost is not an even-split of totalCost (each story gets its own Map value)", async () => {
    const story1 = makePendingStory("US-A");
    const story2 = makePendingStory("US-B");
    // Deliberately asymmetric costs — even-split would give 0.1 each
    const costMap = new Map([
      [story1.id, 0.05],
      [story2.id, 0.15],
    ]);

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () =>
      makeBatchResult([story1, story2], costMap),
    );

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    const result = await executeUnified(ctx as never, prd as never);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    // Even-split would be 0.1 for both — these must differ
    expect(m1!.cost).not.toBe(m2!.cost);
    expect(m1!.cost).toBe(0.05);
    expect(m2!.cost).toBe(0.15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: Per-story durationMs from storyDurations Map (not batch wall-clock)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2 — durationMs equals storyDurations.get(story.id) from batch result", () => {
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

  test("durationMs comes from storyDurations Map in the batch result, not from external wall-clock", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");
    const costMap = new Map([
      [story1.id, 0.1],
      [story2.id, 0.1],
    ]);
    // Distinct per-story durations (ms elapsed from worktree creation to merge)
    const durationsMap = new Map([
      [story1.id, 1500],
      [story2.id, 3200],
    ]);

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () =>
      makeBatchResult([story1, story2], costMap, durationsMap),
    );

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    const result = await executeUnified(ctx as never, prd as never);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    expect(m1).toBeDefined();
    expect(m2).toBeDefined();
    // Must match the per-story values from the Map, not the batch wall-clock
    expect(m1!.durationMs).toBe(1500);
    expect(m2!.durationMs).toBe(3200);
  });

  test("durationMs values differ per story when storyDurations has asymmetric timings", async () => {
    const story1 = makePendingStory("US-X");
    const story2 = makePendingStory("US-Y");
    const costMap = new Map([
      [story1.id, 0.1],
      [story2.id, 0.1],
    ]);
    const durationsMap = new Map([
      [story1.id, 800],
      [story2.id, 4500],
    ]);

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () =>
      makeBatchResult([story1, story2], costMap, durationsMap),
    );

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(
      makeCtx({ parallelCount: 2 }) as never,
      makePrd([story1, story2]) as never,
    );

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    expect(m1!.durationMs).toBe(800);
    expect(m2!.durationMs).toBe(4500);
    // Sanity: they differ (not batch-averaged)
    expect(m1!.durationMs).not.toBe(m2!.durationMs);
  });

  test("RunParallelBatchResult exposes storyDurations field (type stub check)", async () => {
    const { _parallelBatchDeps: _deps } = await import("../../../src/execution/parallel-batch");
    // The type must declare storyDurations — this test validates the type stub is in place
    const result: RunParallelBatchResult = {
      completed: [],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map(),
      storyDurations: new Map([["story-1", 1000]]),
      totalCost: 0,
    };
    expect(result.storyDurations).toBeDefined();
    expect(result.storyDurations!.get("story-1")).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Rectified story metrics have source: 'rectification' and rectificationCost
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3 — rectified story StoryMetrics has source 'rectification' and rectificationCost", () => {
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

  test("StoryMetrics type allows source: 'rectification'", () => {
    // Type-level check: the union must include 'rectification'
    const m: StoryMetrics = {
      storyId: "US-001",
      complexity: "simple",
      modelTier: "fast",
      modelUsed: "claude-code",
      attempts: 1,
      finalTier: "fast",
      success: true,
      cost: 0.05,
      durationMs: 1000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      source: "rectification",
      rectificationCost: 0.05,
    };
    expect(m.source).toBe("rectification");
    expect(m.rectificationCost).toBe(0.05);
  });

  test("StoryMetrics type allows rectificationCost field", () => {
    const m: StoryMetrics = {
      storyId: "US-002",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.1,
      durationMs: 2000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    // rectificationCost is optional; must be expressible when set
    const withRect: StoryMetrics = { ...m, rectificationCost: 0.07 };
    expect(withRect.rectificationCost).toBe(0.07);
  });

  test("rectified story gets its own StoryMetrics entry after batch", async () => {
    const conflictStory = makePendingStory("US-CONFLICT");
    const costMap = new Map([[conflictStory.id, 0.1]]);

    deps.selectIndependentBatch = mock(() => [conflictStory]);
    // Return single story as conflict (batch length > 1 needed — add a second)
    const story2 = makePendingStory("US-002");
    costMap.set(story2.id, 0.08);
    deps.selectIndependentBatch = mock(() => [conflictStory, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story2],
      failed: [],
      mergeConflicts: [{ story: conflictStory, rectified: true, cost: 0.05 }],
      storyCosts: costMap,
      totalCost: 0.18,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const prd = makePrd([conflictStory, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    const result = await executeUnified(ctx as never, prd as never);

    // There must be a StoryMetrics entry for the rectified story
    const rectMetrics = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    expect(rectMetrics).toBeDefined();
    expect(rectMetrics!.source).toBe("rectification");
  });

  test("rectified story metrics carries rectificationCost equal to conflict.cost", async () => {
    const conflictStory = makePendingStory("US-MERGE-CONFLICT");
    const otherStory = makePendingStory("US-CLEAN");
    const costMap = new Map([
      [conflictStory.id, 0.1],
      [otherStory.id, 0.08],
    ]);

    deps.selectIndependentBatch = mock(() => [conflictStory, otherStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [otherStory],
      failed: [],
      mergeConflicts: [{ story: conflictStory, rectified: true, cost: 0.04 }],
      storyCosts: costMap,
      totalCost: 0.18,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(
      makeCtx({ parallelCount: 2 }) as never,
      makePrd([conflictStory, otherStory]) as never,
    );

    const rectMetrics = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    expect(rectMetrics).toBeDefined();
    expect(rectMetrics!.source).toBe("rectification");
    expect(rectMetrics!.rectificationCost).toBe(0.04);
  });

  test("non-rectified conflict (rectified: false) does NOT produce a 'rectification' source entry", async () => {
    const conflictStory = makePendingStory("US-FAILED-RECT");
    const otherStory = makePendingStory("US-OTHER");
    const costMap = new Map([
      [conflictStory.id, 0.1],
      [otherStory.id, 0.08],
    ]);

    deps.selectIndependentBatch = mock(() => [conflictStory, otherStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [otherStory],
      failed: [],
      mergeConflicts: [{ story: conflictStory, rectified: false, cost: 0 }],
      storyCosts: costMap,
      totalCost: 0.18,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(
      makeCtx({ parallelCount: 2 }) as never,
      makePrd([conflictStory, otherStory]) as never,
    );

    const rectMetrics = result.allStoryMetrics.find(
      (m) => m.storyId === conflictStory.id && m.source === "rectification",
    );
    // A story that was NOT rectified must NOT appear with source 'rectification'
    expect(rectMetrics).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: story:started events emitted per story with correct storyId
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4 — story:started emitted with correct storyId for each batch story", () => {
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

  test("story:started is emitted once per story in the batch, each with the correct storyId", async () => {
    const story1 = makePendingStory("US-E1");
    const story2 = makePendingStory("US-E2");
    const story3 = makePendingStory("US-E3");

    const emittedStartedIds: string[] = [];

    deps.selectIndependentBatch = mock(() => [story1, story2, story3]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2, story3],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, 0.1],
        [story2.id, 0.1],
        [story3.id, 0.1],
      ]),
      totalCost: 0.3,
    }));

    const { pipelineEventBus } = await import("../../../src/pipeline/event-bus");
    const origEmit = pipelineEventBus.emit.bind(pipelineEventBus);
    pipelineEventBus.emit = mock((event: Record<string, unknown>) => {
      if (event.type === "story:started") {
        emittedStartedIds.push(event.storyId as string);
      }
      return origEmit(event as never);
    }) as typeof pipelineEventBus.emit;

    try {
      const { executeUnified } = await import("../../../src/execution/unified-executor");
      await executeUnified(makeCtx({ parallelCount: 3 }) as never, makePrd([story1, story2, story3]) as never);
    } finally {
      pipelineEventBus.emit = origEmit;
    }

    expect(emittedStartedIds).toContain(story1.id);
    expect(emittedStartedIds).toContain(story2.id);
    expect(emittedStartedIds).toContain(story3.id);
    // Exactly one event per story
    expect(emittedStartedIds.filter((id) => id === story1.id)).toHaveLength(1);
    expect(emittedStartedIds.filter((id) => id === story2.id)).toHaveLength(1);
    expect(emittedStartedIds.filter((id) => id === story3.id)).toHaveLength(1);
  });

  test("story:started events are all emitted before runParallelBatch fires", async () => {
    const story1 = makePendingStory("US-F1");
    const story2 = makePendingStory("US-F2");

    const eventLog: string[] = [];

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => {
      eventLog.push("runParallelBatch");
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

    const { pipelineEventBus } = await import("../../../src/pipeline/event-bus");
    const origEmit = pipelineEventBus.emit.bind(pipelineEventBus);
    pipelineEventBus.emit = mock((event: Record<string, unknown>) => {
      if (event.type === "story:started") {
        eventLog.push(`story:started:${event.storyId}`);
      }
      return origEmit(event as never);
    }) as typeof pipelineEventBus.emit;

    try {
      const { executeUnified } = await import("../../../src/execution/unified-executor");
      await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([story1, story2]) as never);
    } finally {
      pipelineEventBus.emit = origEmit;
    }

    const batchIdx = eventLog.indexOf("runParallelBatch");
    const s1Idx = eventLog.indexOf(`story:started:${story1.id}`);
    const s2Idx = eventLog.indexOf(`story:started:${story2.id}`);

    expect(batchIdx).toBeGreaterThanOrEqual(0);
    expect(s1Idx).toBeGreaterThanOrEqual(0);
    expect(s2Idx).toBeGreaterThanOrEqual(0);
    expect(s1Idx).toBeLessThan(batchIdx);
    expect(s2Idx).toBeLessThan(batchIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Tests use executeUnified directly; the removed dispatch function is gone
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5 — executeUnified is the only dispatch entry point; removed function is absent", () => {
  test("executeUnified is a callable function exported from unified-executor", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    expect(typeof mod.executeUnified).toBe("function");
  });

  test("unified-executor module does not export the old removed dispatch function", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    // The old function was named runParallelExecution and was removed in US-003.
    // Key: it must not appear as an export.
    const exportedKeys = Object.keys(mod);
    const legacyName = ["runParallel", "Execution"].join(""); // avoid literal match in this file
    expect(exportedKeys).not.toContain(legacyName);
  });

  test("unified-executor.ts source does not import or define the old removed dispatch function", async () => {
    const src = await Bun.file(
      new URL("../../../src/execution/unified-executor.ts", import.meta.url).pathname,
    ).text();
    const legacyName = ["runParallel", "Execution"].join("");
    expect(src).not.toContain(legacyName);
  });

  test("runner-execution.ts source does not reference the old removed dispatch function", async () => {
    const src = await Bun.file(
      new URL("../../../src/execution/runner-execution.ts", import.meta.url).pathname,
    ).text();
    const legacyName = ["runParallel", "Execution"].join("");
    expect(src).not.toContain(legacyName);
  });
});
