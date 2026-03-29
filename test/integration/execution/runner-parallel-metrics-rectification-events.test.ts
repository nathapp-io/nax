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
import { initLogger, resetLogger } from "../../../src/logger";
import type { StoryMetrics } from "../../../src/metrics";
import type { UserStory } from "../../../src/prd/types";
import { makePendingStory, makePrd, makeCtx } from "./_parallel-metrics-helpers";

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

    const { executeUnified } = await import("../../../src/execution/unified-executor");
    const result = await executeUnified(
      makeCtx({ parallelCount: 2 }) as never,
      makePrd([conflictStory, story2]) as never,
    );

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
      await executeUnified(
        makeCtx({ parallelCount: 3 }) as never,
        makePrd([story1, story2, story3]) as never,
      );
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
