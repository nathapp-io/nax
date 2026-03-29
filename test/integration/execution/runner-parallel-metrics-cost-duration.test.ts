/**
 * Integration tests for US-004: Fix per-story metrics accuracy.
 *
 * Covers:
 *   AC-1  Each completed story's cost equals storyCosts.get(story.id)
 *   AC-2  Each completed story's durationMs equals storyDurations.get(story.id)
 *         from the batch result (per-story, not batch wall-clock)
 *   AC-5  These tests call executeUnified directly — the old dispatch function is never referenced
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLogger, resetLogger } from "../../../src/logger";
import type { RunParallelBatchResult } from "../../../src/execution/parallel-batch";
import type { UserStory } from "../../../src/prd/types";
import { makePendingStory, makePrd, makeCtx } from "./_parallel-metrics-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

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

beforeEach(() => {
  initLogger();
});

afterEach(() => {
  resetLogger();
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

  test("RunParallelBatchResult exposes storyDurations field (type stub check)", () => {
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
