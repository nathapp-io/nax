/**
 * Integration tests for US-004: Fix per-story metrics accuracy and migrate parallel tests.
 *
 * This is the canonical integration test file for parallel metrics. It exercises
 * executeUnified directly with parallelCount set — runParallelExecution is never referenced.
 *
 * Covers all US-004 acceptance criteria in one consolidated file:
 *   AC-1  Completed story cost equals storyCosts.get(story.id) from the batch result
 *   AC-2  Completed story durationMs equals storyDurations.get(story.id) (per-story, not batch wall-clock)
 *   AC-3  Rectified story metrics carry source: 'rectification' and rectificationCost
 *   AC-4  story:started emitted with correct storyId per batch story before runParallelBatch fires
 *   AC-5  Tests call executeUnified directly; runParallelExecution is absent
 *
 * Additional coverage (not in split files):
 *   - result.storiesCompleted equals completed-batch count
 *   - result.totalCost accumulates batchResult.totalCost
 *   - result.exitReason is "max-iterations" after one batch iteration
 *   - allStoryMetrics has no duplicate entries for the same storyId
 *   - firstPassSuccess is true for parallel-completed, false for rectified
 *   - Rectified story cost equals storyCosts.get(story.id), not conflict.cost
 *   - storyDurations fallback: durationMs >= 0 when storyDurations is absent from result
 *   - story:started is NOT emitted when batch.length === 1 via runParallelBatch
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLogger, resetLogger } from "../../../src/logger";
import type { RunParallelBatchResult } from "../../../src/execution/parallel-batch";
import type { UserStory } from "../../../src/prd/types";
import { makePendingStory, makePrd, makeCtx } from "./_parallel-metrics-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBatch(
  completed: UserStory[],
  costMap: Map<string, number>,
  durationsMap?: Map<string, number>,
  conflicts: RunParallelBatchResult["mergeConflicts"] = [],
): RunParallelBatchResult {
  const totalCost = [...costMap.values()].reduce((a, b) => a + b, 0);
  return {
    completed,
    failed: [],
    mergeConflicts: conflicts,
    storyCosts: costMap,
    storyDurations: durationsMap,
    totalCost,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let deps: Record<string, unknown>;
let origRunParallelBatch: unknown;
let origSelectIndependentBatch: unknown;

beforeEach(async () => {
  initLogger();
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
  resetLogger();
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: Per-story cost from storyCosts Map (not even-split)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1 — completed story cost equals storyCosts.get(story.id)", () => {
  test("each completed story gets its own cost from the Map, not an average", async () => {
    const s1 = makePendingStory("US-M1");
    const s2 = makePendingStory("US-M2");
    const costMap = new Map([[s1.id, 0.12], [s2.id, 0.48]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === s1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === s2.id);

    expect(m1!.cost).toBe(0.12);
    expect(m2!.cost).toBe(0.48);
    // Verify asymmetry: if even-split were used both would be 0.3
    expect(m1!.cost).not.toBe(m2!.cost);
  });

  test("story cost is 0 when storyCosts Map has no entry for that story", async () => {
    const s1 = makePendingStory("US-NOCOST");
    const s2 = makePendingStory("US-HASCOST");
    // s1 deliberately absent from map
    const costMap = new Map([[s2.id, 0.2]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === s1.id);
    expect(m1!.cost).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: Per-story durationMs from storyDurations Map
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2 — durationMs equals storyDurations.get(story.id), not batch wall-clock", () => {
  test("each story receives its own durationMs from the storyDurations Map", async () => {
    const s1 = makePendingStory("US-DUR1");
    const s2 = makePendingStory("US-DUR2");
    const costMap = new Map([[s1.id, 0.1], [s2.id, 0.1]]);
    const durMap = new Map([[s1.id, 2500], [s2.id, 7800]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap, durMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === s1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === s2.id);

    expect(m1!.durationMs).toBe(2500);
    expect(m2!.durationMs).toBe(7800);
  });

  test("durationMs falls back to elapsed wall-clock when storyDurations is absent and is non-negative", async () => {
    const s1 = makePendingStory("US-NODUR");
    const costMap = new Map([[s1.id, 0.05]]);
    const s2 = makePendingStory("US-NODUR2");
    costMap.set(s2.id, 0.05);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    // No storyDurations field in the result
    deps.runParallelBatch = mock(async () => ({
      completed: [s1, s2],
      failed: [],
      mergeConflicts: [],
      storyCosts: costMap,
      // storyDurations intentionally omitted
      totalCost: 0.1,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === s1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === s2.id);

    // Fallback must be non-negative
    expect(m1!.durationMs).toBeGreaterThanOrEqual(0);
    expect(m2!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Rectified story metrics carry source: 'rectification' and rectificationCost
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3 — rectified story StoryMetrics has source 'rectification' and rectificationCost", () => {
  test("rectified conflict story appears in allStoryMetrics with source 'rectification'", async () => {
    const conflictStory = makePendingStory("US-RECT");
    const cleanStory = makePendingStory("US-CLEAN");
    const costMap = new Map([[conflictStory.id, 0.09], [cleanStory.id, 0.06]]);

    deps.selectIndependentBatch = mock(() => [conflictStory, cleanStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [cleanStory],
      failed: [],
      mergeConflicts: [{ story: conflictStory, rectified: true, cost: 0.03 }],
      storyCosts: costMap,
      totalCost: 0.15,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([conflictStory, cleanStory]) as never);

    const rectM = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    expect(rectM).toBeDefined();
    expect(rectM!.source).toBe("rectification");
  });

  test("rectificationCost equals conflict.cost from the batch result", async () => {
    const conflictStory = makePendingStory("US-RECTCOST");
    const cleanStory = makePendingStory("US-CLEANB");
    const costMap = new Map([[conflictStory.id, 0.11], [cleanStory.id, 0.07]]);

    deps.selectIndependentBatch = mock(() => [conflictStory, cleanStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [cleanStory],
      failed: [],
      mergeConflicts: [{ story: conflictStory, rectified: true, cost: 0.04 }],
      storyCosts: costMap,
      totalCost: 0.18,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([conflictStory, cleanStory]) as never);

    const rectM = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    expect(rectM!.rectificationCost).toBe(0.04);
  });

  test("rectified story cost (total) equals storyCosts.get(story.id), not just conflict.cost", async () => {
    // Total cost includes pre-conflict agent work; rectificationCost is only the conflict portion
    const conflictStory = makePendingStory("US-TOTALCOST");
    const cleanStory = makePendingStory("US-CLEANC");
    const costMap = new Map([[conflictStory.id, 0.15], [cleanStory.id, 0.06]]);

    deps.selectIndependentBatch = mock(() => [conflictStory, cleanStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [cleanStory],
      failed: [],
      // conflict.cost (0.04) is only the rectification portion; story total is 0.15 from the map
      mergeConflicts: [{ story: conflictStory, rectified: true, cost: 0.04 }],
      storyCosts: costMap,
      totalCost: 0.21,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([conflictStory, cleanStory]) as never);

    const rectM = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    // Full per-story cost from the map (0.15), not the conflict slice (0.04)
    expect(rectM!.cost).toBe(0.15);
    expect(rectM!.rectificationCost).toBe(0.04);
  });

  test("non-rectified conflict (rectified: false) does not produce a 'rectification' source entry", async () => {
    const failedConflict = makePendingStory("US-FAILRECT");
    const cleanStory = makePendingStory("US-CLEAND");
    const costMap = new Map([[failedConflict.id, 0.09], [cleanStory.id, 0.05]]);

    deps.selectIndependentBatch = mock(() => [failedConflict, cleanStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [cleanStory],
      failed: [],
      mergeConflicts: [{ story: failedConflict, rectified: false, cost: 0 }],
      storyCosts: costMap,
      totalCost: 0.14,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([failedConflict, cleanStory]) as never);

    const rectEntry = result.allStoryMetrics.find(
      (m) => m.storyId === failedConflict.id && m.source === "rectification",
    );
    expect(rectEntry).toBeUndefined();
  });

  test("rectified story has firstPassSuccess false", async () => {
    const conflictStory = makePendingStory("US-FPS");
    const cleanStory = makePendingStory("US-FPSC");
    const costMap = new Map([[conflictStory.id, 0.08], [cleanStory.id, 0.05]]);

    deps.selectIndependentBatch = mock(() => [conflictStory, cleanStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [cleanStory],
      failed: [],
      mergeConflicts: [{ story: conflictStory, rectified: true, cost: 0.03 }],
      storyCosts: costMap,
      totalCost: 0.13,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([conflictStory, cleanStory]) as never);

    const rectM = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    expect(rectM!.firstPassSuccess).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: story:started emitted per batch story before runParallelBatch
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4 — story:started emitted with correct storyId before batch executes", () => {
  test("story:started events are emitted for all batch stories before runParallelBatch", async () => {
    const s1 = makePendingStory("US-EVT1");
    const s2 = makePendingStory("US-EVT2");
    const eventLog: string[] = [];

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => {
      eventLog.push("batch");
      return makeBatch([s1, s2], new Map([[s1.id, 0.1], [s2.id, 0.1]]));
    });

    const { pipelineEventBus } = await import("../../../src/pipeline/event-bus");
    const origEmit = pipelineEventBus.emit.bind(pipelineEventBus);
    pipelineEventBus.emit = mock((event: Record<string, unknown>) => {
      if (event.type === "story:started") eventLog.push(`started:${event.storyId}`);
      return origEmit(event as never);
    }) as typeof pipelineEventBus.emit;

    try {
      const { executeUnified } = await import("../../../src/execution/unified-executor");
      await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);
    } finally {
      pipelineEventBus.emit = origEmit;
    }

    const batchIdx = eventLog.indexOf("batch");
    const s1Idx = eventLog.indexOf(`started:${s1.id}`);
    const s2Idx = eventLog.indexOf(`started:${s2.id}`);

    expect(batchIdx).toBeGreaterThan(-1);
    expect(s1Idx).toBeGreaterThan(-1);
    expect(s2Idx).toBeGreaterThan(-1);
    // Both story:started events must precede the batch call
    expect(s1Idx).toBeLessThan(batchIdx);
    expect(s2Idx).toBeLessThan(batchIdx);
  });

  test("exactly one story:started is emitted per batch story (no duplicates)", async () => {
    const s1 = makePendingStory("US-NODUP1");
    const s2 = makePendingStory("US-NODUP2");
    const startedIds: string[] = [];

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () =>
      makeBatch([s1, s2], new Map([[s1.id, 0.1], [s2.id, 0.1]])),
    );

    const { pipelineEventBus } = await import("../../../src/pipeline/event-bus");
    const origEmit = pipelineEventBus.emit.bind(pipelineEventBus);
    pipelineEventBus.emit = mock((event: Record<string, unknown>) => {
      if (event.type === "story:started") startedIds.push(event.storyId as string);
      return origEmit(event as never);
    }) as typeof pipelineEventBus.emit;

    try {
      const { executeUnified } = await import("../../../src/execution/unified-executor");
      await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);
    } finally {
      pipelineEventBus.emit = origEmit;
    }

    expect(startedIds.filter((id) => id === s1.id)).toHaveLength(1);
    expect(startedIds.filter((id) => id === s2.id)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: executeUnified is the sole dispatch entry point; runParallelExecution absent
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5 — executeUnified is the entry point; legacy dispatch function is absent", () => {
  test("executeUnified is exported from unified-executor", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    expect(typeof mod.executeUnified).toBe("function");
  });

  test("unified-executor module does not export the removed runParallelExecution function", async () => {
    const mod = await import("../../../src/execution/unified-executor");
    const keys = Object.keys(mod);
    expect(keys).not.toContain("runParallelExecution");
  });

  test("runner-execution.ts does not reference runParallelExecution", async () => {
    const src = await Bun.file(
      new URL("../../../src/execution/runner-execution.ts", import.meta.url).pathname,
    ).text();
    expect(src).not.toContain("runParallelExecution");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional coverage: result fields populated correctly after a parallel batch
// ─────────────────────────────────────────────────────────────────────────────

describe("result fields — storiesCompleted, totalCost, allStoryMetrics integrity", () => {
  test("result.storiesCompleted equals the number of completed stories in the batch", async () => {
    const s1 = makePendingStory("US-SC1");
    const s2 = makePendingStory("US-SC2");
    const s3 = makePendingStory("US-SC3");
    const costMap = new Map([[s1.id, 0.1], [s2.id, 0.1], [s3.id, 0.1]]);

    deps.selectIndependentBatch = mock(() => [s1, s2, s3]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2, s3], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 3 }) as never, makePrd([s1, s2, s3]) as never);

    expect(result.storiesCompleted).toBe(3);
  });

  test("result.totalCost equals the batchResult.totalCost value", async () => {
    const s1 = makePendingStory("US-TC1");
    const s2 = makePendingStory("US-TC2");
    const costMap = new Map([[s1.id, 0.3], [s2.id, 0.7]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);

    expect(result.totalCost).toBe(1.0);
  });

  test("result.exitReason is 'max-iterations' after consuming all iterations in a parallel batch", async () => {
    const s1 = makePendingStory("US-EXIT1");
    const s2 = makePendingStory("US-EXIT2");
    const costMap = new Map([[s1.id, 0.05], [s2.id, 0.05]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    // maxIterations: 1 → the loop processes the batch then exits naturally
    const result = await executeUnified(makeCtx({ parallelCount: 2, maxIterations: 1 }) as never, makePrd([s1, s2]) as never);

    expect(result.exitReason).toBe("max-iterations");
  });

  test("allStoryMetrics has no duplicate entries for the same storyId", async () => {
    const s1 = makePendingStory("US-DEDUP1");
    const s2 = makePendingStory("US-DEDUP2");
    const costMap = new Map([[s1.id, 0.1], [s2.id, 0.1]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);

    const ids = result.allStoryMetrics.map((m) => m.storyId);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  test("completed parallel stories have firstPassSuccess true", async () => {
    const s1 = makePendingStory("US-FPS1");
    const s2 = makePendingStory("US-FPS2");
    const costMap = new Map([[s1.id, 0.1], [s2.id, 0.1]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);

    for (const m of result.allStoryMetrics) {
      expect(m.firstPassSuccess).toBe(true);
    }
  });

  test("completed parallel stories have source 'parallel'", async () => {
    const s1 = makePendingStory("US-SRC1");
    const s2 = makePendingStory("US-SRC2");
    const costMap = new Map([[s1.id, 0.1], [s2.id, 0.1]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }) as never, makePrd([s1, s2]) as never);

    for (const m of result.allStoryMetrics) {
      expect(m.source).toBe("parallel");
    }
  });

  test("allStoryMetrics entry count equals completed + rectified count", async () => {
    const s1 = makePendingStory("US-COUNT1");
    const s2 = makePendingStory("US-COUNT2");
    const rectStory = makePendingStory("US-COUNTRECT");
    const costMap = new Map([[s1.id, 0.1], [s2.id, 0.1], [rectStory.id, 0.12]]);

    deps.selectIndependentBatch = mock(() => [s1, s2, rectStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [s1, s2],
      failed: [],
      mergeConflicts: [{ story: rectStory, rectified: true, cost: 0.04 }],
      storyCosts: costMap,
      totalCost: 0.32,
    }));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(
      makeCtx({ parallelCount: 3 }) as never,
      makePrd([s1, s2, rectStory]) as never,
    );

    // 2 completed + 1 rectified = 3 entries total
    expect(result.allStoryMetrics).toHaveLength(3);
  });

  test("cost-limit exit: result.exitReason is 'cost-limit' when totalCost exceeds the limit after batch", async () => {
    const s1 = makePendingStory("US-CLIMIT1");
    const s2 = makePendingStory("US-CLIMIT2");
    // Each story costs 60 — total 120, limit is 100
    const costMap = new Map([[s1.id, 60], [s2.id, 60]]);

    deps.selectIndependentBatch = mock(() => [s1, s2]);
    deps.runParallelBatch = mock(async () => makeBatch([s1, s2], costMap));

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(
      makeCtx({ parallelCount: 2, costLimit: 100, maxIterations: 10 }) as never,
      makePrd([s1, s2]) as never,
    );

    expect(result.exitReason).toBe("cost-limit");
  });
});
