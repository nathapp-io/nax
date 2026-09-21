/**
 * Integration tests for US-004: Fix per-story metrics accuracy.
 *
 * Tests invoke executeUnified directly with parallelCount set.
 *
 * Covers:
 *   AC-3  Rectified stories have source: 'rectification' and rectificationCost
 *         in their StoryMetrics entry
 *   AC-4  story:started events emitted with correct storyId per story before batch
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { RunParallelBatchResult } from "@/execution/parallel-batch";
import { initLogger, resetLogger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import type { PipelineEvent } from "@/pipeline/event-bus";
import type { UserStory } from "@/prd/types";
import { makeCtx, makePendingStory, makePrd } from "./_parallel-metrics-helpers";

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
// AC-3: Rectified story metrics have source: 'rectification' and rectificationCost
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3 — rectified story StoryMetrics has source 'rectification' and rectificationCost", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
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
    const withRect: StoryMetrics = { ...m, rectificationCost: 0.07 };
    expect(withRect.rectificationCost).toBe(0.07);
  });

  test("rectified story gets its own StoryMetrics entry after batch", async () => {
    const conflictStory = makePendingStory("US-CONFLICT");
    const costMap = new Map([[conflictStory.id, 0.1]]);
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

    const { executeUnified } = await import("@/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }), makePrd([conflictStory, story2]));

    const rectMetrics = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    assertDefined(rectMetrics, "rectMetrics");
    expect(rectMetrics.source).toBe("rectification");
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

    const { executeUnified } = await import("@/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }), makePrd([conflictStory, otherStory]));

    const rectMetrics = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    assertDefined(rectMetrics, "rectMetrics");
    expect(rectMetrics.source).toBe("rectification");
    expect(rectMetrics.rectificationCost).toBe(0.04);
  });

  // BUG-3 (nax review 20260829): a non-rectified conflict used to be silently
  // dropped from allStoryMetrics — invisible to per-agent cost attribution and
  // the run rollup. It must now appear, marked failed. See
  // unified-executor.ts's recordMergeConflictOutcomes and
  // test/unit/execution/unified-executor-dispatch.test.ts's "BUG-3" suite for
  // the event-bus half of this fix.
  test("non-rectified conflict (rectified: false) DOES produce a 'rectification' source entry, marked failed", async () => {
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

    const { executeUnified } = await import("@/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }), makePrd([conflictStory, otherStory]));

    const rectMetrics = result.allStoryMetrics.find(
      (m) => m.storyId === conflictStory.id && m.source === "rectification",
    );
    assertDefined(rectMetrics, "rectMetrics");
    expect(rectMetrics.success).toBe(false);
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
    const mod = await import("@/execution/unified-executor");
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

    const { pipelineEventBus } = await import("@/pipeline/event-bus");
    const origEmit = pipelineEventBus.emit.bind(pipelineEventBus);
    pipelineEventBus.emit = mock((event: PipelineEvent) => {
      if (event.type === "story:started") {
        emittedStartedIds.push(event.storyId as string);
      }
      return origEmit(event);
    });

    try {
      const { executeUnified } = await import("@/execution/unified-executor");
      await executeUnified(makeCtx({ parallelCount: 3 }), makePrd([story1, story2, story3]));
    } finally {
      pipelineEventBus.emit = origEmit;
    }

    expect(emittedStartedIds).toContain(story1.id);
    expect(emittedStartedIds).toContain(story2.id);
    expect(emittedStartedIds).toContain(story3.id);
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

    const { pipelineEventBus } = await import("@/pipeline/event-bus");
    const origEmit = pipelineEventBus.emit.bind(pipelineEventBus);
    pipelineEventBus.emit = mock((event: PipelineEvent) => {
      if (event.type === "story:started") {
        eventLog.push(`story:started:${event.storyId}`);
      }
      return origEmit(event);
    });

    try {
      const { executeUnified } = await import("@/execution/unified-executor");
      await executeUnified(makeCtx({ parallelCount: 2 }), makePrd([story1, story2]));
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
// US-004 AC-1/AC-2/AC-5: per-story cost and duration, and the executeUnified
// cut-over. Local helper makeBatchResult() builds a batch result with the
// per-story maps the assertions read.
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

describe("AC-1 — completed story cost equals storyCosts.get(story.id)", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
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
    deps.runParallelBatch = mock(async () => makeBatchResult([story1, story2], costMap));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    const result = await executeUnified(ctx, prd);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    assertDefined(m1, `metric for ${story1.id}`);
    assertDefined(m2, `metric for ${story2.id}`);
    expect(m1.cost).toBe(0.15);
    expect(m2.cost).toBe(0.25);
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
    deps.runParallelBatch = mock(async () => makeBatchResult([story1, story2], costMap));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    const result = await executeUnified(ctx, prd);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    assertDefined(m1, `metric for ${story1.id}`);
    assertDefined(m2, `metric for ${story2.id}`);

    // Even-split would be 0.1 for both — these must differ
    expect(m1.cost).not.toBe(m2.cost);
    expect(m1.cost).toBe(0.05);
    expect(m2.cost).toBe(0.15);
  });
});

describe("AC-2 — durationMs equals storyDurations.get(story.id) from batch result", () => {
  let deps: Record<string, unknown>;
  let origRunParallelBatch: unknown;
  let origSelectIndependentBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
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
    deps.runParallelBatch = mock(async () => makeBatchResult([story1, story2], costMap, durationsMap));

    const { executeUnified } = await import("@/execution/unified-executor");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx({ parallelCount: 2 });

    const result = await executeUnified(ctx, prd);

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    assertDefined(m1, `metric for ${story1.id}`);
    assertDefined(m2, `metric for ${story2.id}`);
    // Must match the per-story values from the Map, not the batch wall-clock
    expect(m1.durationMs).toBe(1500);
    expect(m2.durationMs).toBe(3200);
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
    deps.runParallelBatch = mock(async () => makeBatchResult([story1, story2], costMap, durationsMap));

    const { executeUnified } = await import("@/execution/unified-executor");
    const result = await executeUnified(makeCtx({ parallelCount: 2 }), makePrd([story1, story2]));

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    assertDefined(m1, `metric for ${story1.id}`);
    assertDefined(m2, `metric for ${story2.id}`);
    expect(m1.durationMs).toBe(800);
    expect(m2.durationMs).toBe(4500);
    // Sanity: they differ (not batch-averaged)
    expect(m1.durationMs).not.toBe(m2.durationMs);
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
    const durations = result.storyDurations;
    assertDefined(durations, "result.storyDurations");
    expect(durations.get("story-1")).toBe(1000);
  });
});

describe("AC-5 — executeUnified is the only dispatch entry point; removed function is absent", () => {
  test("executeUnified is a callable function exported from unified-executor", async () => {
    const mod = await import("@/execution/unified-executor");
    expect(typeof mod.executeUnified).toBe("function");
  });

  test("unified-executor module does not export the old removed dispatch function", async () => {
    const mod = await import("@/execution/unified-executor");
    // The old function was named runParallelExecution and was removed in US-003.
    // Key: it must not appear as an export.
    const exportedKeys = Object.keys(mod);
    const legacyName = ["runParallel", "Execution"].join(""); // avoid literal match in this file
    expect(exportedKeys).not.toContain(legacyName);
  });

  test("unified-executor.ts source does not import or define the old removed dispatch function", async () => {
    const src = await Bun.file(new URL("../../../src/execution/unified-executor.ts", import.meta.url).pathname).text();
    const legacyName = ["runParallel", "Execution"].join("");
    expect(src).not.toContain(legacyName);
  });

  test("runner-execution.ts source does not reference the old removed dispatch function", async () => {
    const src = await Bun.file(new URL("../../../src/execution/runner-execution.ts", import.meta.url).pathname).text();
    const legacyName = ["runParallel", "Execution"].join("");
    expect(src).not.toContain(legacyName);
  });
});
