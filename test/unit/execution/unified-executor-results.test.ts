/**
 * Behavioral tests for executeUnified result shape and per-story metrics.
 *
 * File: unified-executor-results.test.ts
 * Covers:
 *   exec AC-18  return value matches SequentialExecutionResult shape (all required keys)
 *   results AC-1  completed stories: allStoryMetrics entry has success=true, source='parallel'
 *   results AC-2  failed stories: failed[] in batchResult still carries pipelineResult
 *   results AC-3  merge conflicts: allStoryMetrics entry has source='rectification' when rectified
 *   results AC-4  per-story cost matches storyCosts.get(story.id)
 *   results AC-5  totalCost sums all branches (completed + conflict)
 *   exec AC-29   per-story cost === storyCosts.get(story.id) — NOT divided equally
 *   exec AC-30   durationMs is per-story elapsed; two stories in one batch may differ
 *   exec AC-31   rectification entry has source='rectification' and rectificationCost set
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { SequentialExecutionContext } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { UserStory } from "@/prd/types";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

// executeUnified starts a heartbeat that runner.ts normally owns; stop it here
// so the unit suite does not leak parked 60s-timer loops (#1679).
afterEach(() => {
  stopHeartbeat();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers — delegate to shared factories (test-helpers.md); local
// wrappers keep call sites terse (makePendingStory(id) / makePrd(stories)).
// ─────────────────────────────────────────────────────────────────────────────

function makePendingStory(id: string): UserStory {
  return makeStory({ id, title: `Story ${id}`, description: `Description for ${id}` });
}

function makePrd(stories: UserStory[]) {
  return makePRD({ userStories: stories });
}

function makeCtx(overrides: Record<string, unknown> = {}): SequentialExecutionContext {
  return {
    prdPath: "/tmp/test-prd.json",
    workdir: "/tmp/test-workdir",
    config: makeNaxConfig({
      execution: { maxIterations: 1, costLimit: 100, iterationDelayMs: 0 },
    }),
    hooks: EMPTY_HOOKS,
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "run-test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    parallelCount: 2,
    ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: "/tmp/nax-test-results-output" }) }),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// exec AC-18 — SequentialExecutionResult shape
// ─────────────────────────────────────────────────────────────────────────────

describe("exec AC-18: executeUnified return value matches SequentialExecutionResult shape", () => {
  test("AC-18: SequentialExecutionResult has all required keys", async () => {
    type R = import("@/execution/executor-types").SequentialExecutionResult;
    // Compile-time: if any key is missing, TypeScript will reject this file
    const result: R = {
      prd: makePrd([]),
      iterations: 0,
      storiesCompleted: 0,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
    };
    expect(result).toHaveProperty("prd");
    expect(result).toHaveProperty("iterations");
    expect(result).toHaveProperty("storiesCompleted");
    expect(result).toHaveProperty("totalCost");
    expect(result).toHaveProperty("allStoryMetrics");
    expect(result).toHaveProperty("exitReason");
  });

  test("AC-18: executeUnified returns all SequentialExecutionResult keys at runtime", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");
    const prd = makePrd([story1, story2]);

    const mod = await import("@/execution/unified-executor");
    const deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    const origSelect = deps.selectIndependentBatch;
    const origBatch = deps.runParallelBatch;

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, 0.5],
        [story2.id, 0.3],
      ]),
      totalCost: 0.8,
    }));

    try {
      const result = await mod.executeUnified(makeCtx(), prd);
      // All required keys must exist
      expect(typeof result.iterations).toBe("number");
      expect(typeof result.storiesCompleted).toBe("number");
      expect(typeof result.totalCost).toBe("number");
      expect(Array.isArray(result.allStoryMetrics)).toBe(true);
      expect(typeof result.exitReason).toBe("string");
      expect(result.prd).toBeDefined();
    } finally {
      deps.selectIndependentBatch = origSelect;
      deps.runParallelBatch = origBatch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// results AC-1 + AC-4 + exec AC-29 — completed stories build allStoryMetrics
// ─────────────────────────────────────────────────────────────────────────────

describe("results AC-1 / AC-4 / exec AC-29: completed stories produce correct metrics entries", () => {
  let deps: Record<string, unknown>;
  let origSelect: unknown;
  let origBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origSelect = deps.selectIndependentBatch;
    origBatch = deps.runParallelBatch;
  });

  afterEach(() => {
    deps.selectIndependentBatch = origSelect;
    deps.runParallelBatch = origBatch;
    mock.restore();
  });

  test("AC-1 / AC-4 / AC-29: allStoryMetrics entry per completed story has success=true, source='parallel', and cost from storyCosts", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");
    const story1Cost = 0.75;
    const story2Cost = 0.25;

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, story1Cost],
        [story2.id, story2Cost],
      ]),
      totalCost: story1Cost + story2Cost,
    }));

    const mod = await import("@/execution/unified-executor");
    // nax#1709: callOp records swap hops on the run-scoped stores for parallel stories
    // exactly as it does sequentially, but the executor built its metrics from inline
    // literals carrying neither field — so both stores were written and never read.
    const ctx = makeCtx();
    ctx.runtime.agentFallbacks.set(story1.id, [
      {
        storyId: story1.id,
        priorAgent: "claude",
        newAgent: "codex",
        hop: 1,
        outcome: "fail-quota",
        category: "availability",
        timestamp: "2026-08-25T00:00:00.000Z",
        costUsd: 0.37,
      },
    ]);
    ctx.runtime.runtimeCrashRetries.set(story2.id, 2);

    const result = await mod.executeUnified(ctx, makePrd([story1, story2]));

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    // nax#1709: the recorded hop reaches the parallel metric, minus the producer-only
    // timestamp; a story with no swaps carries no fallback but still reports crash retries.
    expect(m1?.fallback?.hops).toHaveLength(1);
    expect(m1?.fallback?.hops[0].newAgent).toBe("codex");
    expect(m1?.fallback?.hops[0].costUsd).toBe(0.37);
    expect(m1?.fallback?.hops[0]).not.toHaveProperty("timestamp");
    expect(m1?.runtimeCrashes).toBe(0);
    expect(m2?.fallback).toBeUndefined();
    expect(m2?.runtimeCrashes).toBe(2);

    // AC-1: completed story metric shows success
    expect(m1?.success).toBe(true);
    expect(m2?.success).toBe(true);

    // AC-4 / AC-29: per-story cost comes directly from storyCosts, not an average
    expect(m1?.cost).toBe(story1Cost);
    expect(m2?.cost).toBe(story2Cost);
    // Costs are NOT equal to each other (proving they weren't averaged)
    expect(m1?.cost).not.toBe(m2?.cost);

    // source is 'parallel' for batch-completed stories
    expect(m1?.source).toBe("parallel");
    expect(m2?.source).toBe("parallel");
  });

  test("#1575: modelUsed records the story's own agent, not the run default", async () => {
    // Under a cross-agent profile the run default is not what executed the story;
    // booking it to the default misattributes per-agent cost.
    const profiled = makeStory({
      id: "US-PROFILE",
      routing: { complexity: "medium", testStrategy: "test-after", reasoning: "", agent: "pi" },
    });
    const plain = makePendingStory("US-PLAIN");

    deps.selectIndependentBatch = mock(() => [profiled, plain]);
    deps.runParallelBatch = mock(async () => ({
      completed: [profiled, plain],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [profiled.id, 0.1],
        [plain.id, 0.1],
      ]),
      totalCost: 0.2,
    }));

    const mod = await import("@/execution/unified-executor");
    const result = await mod.executeUnified(makeCtx(), makePrd([profiled, plain]));

    expect(result.allStoryMetrics.find((m) => m.storyId === profiled.id)?.modelUsed).toBe("pi");
    // A story with no assigned agent still falls back to the run default.
    expect(result.allStoryMetrics.find((m) => m.storyId === plain.id)?.modelUsed).not.toBe("pi");
  });

  test("exec AC-29: per-story cost != (totalCost / storyCount) when costs are unequal", async () => {
    const story1 = makePendingStory("US-A");
    const story2 = makePendingStory("US-B");
    const costA = 0.9;
    const costB = 0.1;

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, costA],
        [story2.id, costB],
      ]),
      totalCost: costA + costB,
    }));

    const mod = await import("@/execution/unified-executor");
    const result = await mod.executeUnified(makeCtx(), makePrd([story1, story2]));

    const mA = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const mB = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    const averageCost = (costA + costB) / 2;
    // Neither story should have the averaged cost — they have their actual costs
    expect(mA?.cost).not.toBe(averageCost);
    expect(mB?.cost).not.toBe(averageCost);
    expect(mA?.cost).toBe(costA);
    expect(mB?.cost).toBe(costB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// results AC-5 — totalCost sums all branches
// ─────────────────────────────────────────────────────────────────────────────

describe("results AC-5: totalCost sums all batch costs", () => {
  let deps: Record<string, unknown>;
  let origSelect: unknown;
  let origBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origSelect = deps.selectIndependentBatch;
    origBatch = deps.runParallelBatch;
  });

  afterEach(() => {
    deps.selectIndependentBatch = origSelect;
    deps.runParallelBatch = origBatch;
    mock.restore();
  });

  test("AC-5: result.totalCost reflects sum of batch totalCost across iterations", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");
    const batchCost = 1.23;

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, 0.5],
        [story2.id, 0.73],
      ]),
      totalCost: batchCost,
    }));

    const mod = await import("@/execution/unified-executor");
    const result = await mod.executeUnified(makeCtx(), makePrd([story1, story2]));

    // totalCost accumulates the batch's totalCost
    expect(result.totalCost).toBeCloseTo(batchCost, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// results AC-2 — failed stories: batchResult.failed carries pipelineResult
// ─────────────────────────────────────────────────────────────────────────────

describe("results AC-2: failed stories in batchResult carry pipelineResult for downstream routing", () => {
  test("AC-2: handlePipelineFailure is called with pipelineResult from batchResult.failed", async () => {
    // Verify at the source level: unified-executor reads batchResult.failed and passes
    // pipelineResult to handlePipelineFailure inside the loop
    const source = await Bun.file(new URL("../../../src/execution/unified-executor.ts", import.meta.url)).text();
    expect(source).toContain("batchResult.failed");
    // Each failed entry destructures { story, pipelineResult }
    expect(source).toContain("pipelineResult");
    expect(source).toContain("handlePipelineFailure");
    // The loop over batchResult.failed and the handlePipelineFailure call
    // are within 200 characters of each other in source order (same for-loop body)
    const failedLoopIdx = source.indexOf("batchResult.failed");
    const failedLoopAfter = source.indexOf("handlePipelineFailure", failedLoopIdx);
    expect(failedLoopIdx).toBeGreaterThan(0);
    // handlePipelineFailure appears shortly after the batchResult.failed loop header
    expect(failedLoopAfter).toBeGreaterThan(failedLoopIdx);
    expect(failedLoopAfter - failedLoopIdx).toBeLessThan(300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// results AC-3 / exec AC-31 — rectified merge conflicts build metrics correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("results AC-3 / exec AC-31: rectified merge-conflict stories produce correct metrics", () => {
  let deps: Record<string, unknown>;
  let origSelect: unknown;
  let origBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origSelect = deps.selectIndependentBatch;
    origBatch = deps.runParallelBatch;
  });

  afterEach(() => {
    deps.selectIndependentBatch = origSelect;
    deps.runParallelBatch = origBatch;
    mock.restore();
  });

  test("AC-3 / AC-31: rectified conflict entry has source='rectification' and rectificationCost", async () => {
    const story1 = makePendingStory("US-001");
    const conflictStory = makePendingStory("US-002");
    // storyCosts holds only the pre-conflict first-pass cost (BUG-37: rectification's own
    // re-run spend lands solely in mergeConflicts[].cost, never folded into storyCosts).
    const conflictFirstPassCost = 0.38;
    const conflictRectificationCost = 0.42;
    const conflictTotalCost = conflictFirstPassCost + conflictRectificationCost;

    deps.selectIndependentBatch = mock(() => [story1, conflictStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1],
      failed: [],
      mergeConflicts: [
        {
          story: conflictStory,
          rectified: true,
          cost: conflictRectificationCost,
        },
      ],
      storyCosts: new Map([
        [story1.id, 0.3],
        [conflictStory.id, conflictFirstPassCost],
      ]),
      totalCost: 0.3 + conflictTotalCost,
    }));

    const mod = await import("@/execution/unified-executor");
    const result = await mod.executeUnified(makeCtx(), makePrd([story1, conflictStory]));

    const conflictMetric = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);

    // AC-3: merge conflict that was rectified appears in allStoryMetrics
    expect(conflictMetric).toBeDefined();
    // AC-31: source must be 'rectification'
    expect(conflictMetric?.source).toBe("rectification");
    // AC-31: rectificationCost reflects only the rectification phase (conflict.cost)
    expect(conflictMetric?.rectificationCost).toBe(conflictRectificationCost);
    // BUG-37: total cost (cost field) is the first-pass storyCosts entry plus the
    // rectification re-run cost — not storyCosts alone.
    expect(conflictMetric?.cost).toBe(conflictTotalCost);
    // firstPassSuccess is false for a conflict
    expect(conflictMetric?.firstPassSuccess).toBe(false);
  });

  test("AC-3: un-rectified merge conflict does NOT appear in allStoryMetrics", async () => {
    const story1 = makePendingStory("US-001");
    const conflictStory = makePendingStory("US-002");

    deps.selectIndependentBatch = mock(() => [story1, conflictStory]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1],
      failed: [],
      mergeConflicts: [
        {
          story: conflictStory,
          rectified: false,
          cost: 0,
        },
      ],
      storyCosts: new Map([
        [story1.id, 0.3],
        [conflictStory.id, 0],
      ]),
      totalCost: 0.3,
    }));

    const mod = await import("@/execution/unified-executor");
    const result = await mod.executeUnified(makeCtx(), makePrd([story1, conflictStory]));

    const conflictMetric = result.allStoryMetrics.find((m) => m.storyId === conflictStory.id);
    // Un-rectified conflicts are not pushed into allStoryMetrics
    expect(conflictMetric).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exec AC-30 — durationMs is per-story; two stories in one batch may differ
// ─────────────────────────────────────────────────────────────────────────────

describe("exec AC-30: durationMs is per-story elapsed from storyDurations Map", () => {
  let deps: Record<string, unknown>;
  let origSelect: unknown;
  let origBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origSelect = deps.selectIndependentBatch;
    origBatch = deps.runParallelBatch;
  });

  afterEach(() => {
    deps.selectIndependentBatch = origSelect;
    deps.runParallelBatch = origBatch;
    mock.restore();
  });

  test("AC-30: two stories in one batch have different durationMs when storyDurations differ", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");
    const duration1 = 1500; // story1 took 1.5s
    const duration2 = 3200; // story2 took 3.2s

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1, story2],
      failed: [],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, 0.1],
        [story2.id, 0.1],
      ]),
      storyDurations: new Map([
        [story1.id, duration1],
        [story2.id, duration2],
      ]),
      totalCost: 0.2,
    }));

    const mod = await import("@/execution/unified-executor");
    const result = await mod.executeUnified(makeCtx(), makePrd([story1, story2]));

    const m1 = result.allStoryMetrics.find((m) => m.storyId === story1.id);
    const m2 = result.allStoryMetrics.find((m) => m.storyId === story2.id);

    // durationMs comes from storyDurations, not an average
    expect(m1?.durationMs).toBe(duration1);
    expect(m2?.durationMs).toBe(duration2);
    // The two durations differ — confirming per-story tracking
    expect(m1?.durationMs).not.toBe(m2?.durationMs);
  });
});
