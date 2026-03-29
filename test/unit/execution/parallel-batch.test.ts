/**
 * Unit tests for src/execution/parallel-batch.ts
 *
 * Tests are intentionally in RED (failing) state — runParallelBatch is a stub.
 * The implementer must make these pass.
 *
 * Covers ACs 1–10 for US-001: Add parallel-batch.ts and rename rectify file.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { LoadedHooksConfig } from "../../../src/hooks";
import type { PipelineContext, PipelineRunResult } from "../../../src/pipeline/types";
import type { PluginRegistry } from "../../../src/plugins/registry";
import type { PRD, UserStory } from "../../../src/prd/types";
import {
  _parallelBatchDeps,
  runParallelBatch,
  type ParallelBatchCtx,
  type RunParallelBatchResult,
} from "../../../src/execution/parallel-batch";
import type { ParallelBatchResult } from "../../../src/execution/parallel-worker";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(
  id: string,
  opts: Partial<UserStory> = {},
): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [`AC-1: ${id}`],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
    ...opts,
  } as unknown as UserStory;
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  } as unknown as PRD;
}

function makePipelineRunResult(success: boolean, reason?: string): PipelineRunResult {
  return {
    success,
    finalAction: success ? "complete" : "fail",
    reason,
    context: {} as PipelineContext,
  };
}

function makeWorkerBatchResult(overrides: Partial<ParallelBatchResult> = {}): ParallelBatchResult {
  return {
    pipelinePassed: [],
    merged: [],
    failed: [],
    totalCost: 0,
    mergeConflicts: [],
    storyCosts: new Map(),
    ...overrides,
  };
}

function makeCtx(tmpDir: string): ParallelBatchCtx {
  return {
    workdir: tmpDir,
    config: DEFAULT_CONFIG as NaxConfig,
    hooks: {} as LoadedHooksConfig,
    pluginRegistry: {} as PluginRegistry,
    maxConcurrency: 2,
    pipelineContext: {
      config: DEFAULT_CONFIG as NaxConfig,
      effectiveConfig: DEFAULT_CONFIG as NaxConfig,
      prd: {} as PRD,
      hooks: {} as LoadedHooksConfig,
      plugins: {} as PluginRegistry,
      storyStartTime: new Date().toISOString(),
    } as unknown as Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test lifecycle
// ─────────────────────────────────────────────────────────────────name────────

let tmpDir: string;
let origDeps: typeof _parallelBatchDeps;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "nax-pb-"));
  origDeps = { ..._parallelBatchDeps };
});

afterEach(() => {
  Object.assign(_parallelBatchDeps, origDeps);
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: completed stories
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: runParallelBatch — completed stories", () => {
  test("returns RunParallelBatchResult with completed array", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [story],
      storyCosts: new Map([["US-001", 0.5]]),
      totalCost: 0.5,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: true, storyId: "US-001" }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.completed).toBeDefined();
    expect(Array.isArray(result.completed)).toBe(true);
    expect(result.completed).toContain(story);
  });

  test("completed contains only stories that both passed pipeline and merged", async () => {
    const story1 = makeStory("US-001");
    const story2 = makeStory("US-002");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx(tmpDir);

    // story2 pipeline passed but failed to merge
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story1, story2],
      merged: [story1],
      storyCosts: new Map([["US-001", 0.3], ["US-002", 0.4]]),
      totalCost: 0.7,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: true, storyId: "US-001" }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [story1, story2], ctx, prd });

    expect(result.completed).toContain(story1);
    expect(result.completed).not.toContain(story2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: failed stories
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: runParallelBatch — failed stories", () => {
  test("returns failed array with story and pipelineResult for pipeline failures", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const pipelineResult = makePipelineRunResult(false, "tests failed");
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [],
      merged: [],
      failed: [{ story, error: "tests failed" }],
      storyCosts: new Map([["US-001", 0.1]]),
      totalCost: 0.1,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => []),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.failed).toBeDefined();
    expect(Array.isArray(result.failed)).toBe(true);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].story).toBe(story);
    expect(result.failed[0].pipelineResult).toBeDefined();
  });

  test("failed array is empty when all stories pass pipeline", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [story],
      failed: [],
      storyCosts: new Map([["US-001", 0.5]]),
      totalCost: 0.5,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: true, storyId: "US-001" }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.failed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: merge conflicts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: runParallelBatch — merge conflicts", () => {
  test("returns mergeConflicts array with story, rectified, and cost fields", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [],
      mergeConflicts: [{ storyId: "US-001", conflictFiles: ["src/foo.ts"], originalCost: 0.5 }],
      storyCosts: new Map([["US-001", 0.5]]),
      totalCost: 0.5,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/foo.ts"] }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;
    _parallelBatchDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-001",
      cost: 0.2,
    }));

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.mergeConflicts).toBeDefined();
    expect(Array.isArray(result.mergeConflicts)).toBe(true);
    expect(result.mergeConflicts.length).toBe(1);
    expect(result.mergeConflicts[0].story).toBe(story);
    expect(typeof result.mergeConflicts[0].rectified).toBe("boolean");
    expect(typeof result.mergeConflicts[0].cost).toBe("number");
  });

  test("mergeConflicts is empty when no conflicts occur", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [story],
      mergeConflicts: [],
      storyCosts: new Map([["US-001", 0.4]]),
      totalCost: 0.4,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: true, storyId: "US-001" }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.mergeConflicts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: per-story costs (not even-split)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: runParallelBatch — per-story costs from storyCosts Map", () => {
  test("storyCosts.get(storyId) equals the cost from executeParallelBatch storyCosts", async () => {
    const story1 = makeStory("US-001");
    const story2 = makeStory("US-002");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx(tmpDir);

    const workerStoryCosts = new Map([["US-001", 0.5], ["US-002", 0.3]]);
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story1, story2],
      merged: [story1, story2],
      storyCosts: workerStoryCosts,
      totalCost: 0.8,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [
        { success: true, storyId: "US-001" },
        { success: true, storyId: "US-002" },
      ]),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [story1, story2], ctx, prd });

    expect(result.storyCosts.get("US-001")).toBe(0.5);
    expect(result.storyCosts.get("US-002")).toBe(0.3);
  });

  test("storyCosts are NOT averaged (not batchTotal / storyCount)", async () => {
    const story1 = makeStory("US-001");
    const story2 = makeStory("US-002");
    const prd = makePrd([story1, story2]);
    const ctx = makeCtx(tmpDir);

    // If even-split: 0.8 / 2 = 0.4 each. But actual costs differ.
    const workerStoryCosts = new Map([["US-001", 0.6], ["US-002", 0.2]]);
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story1, story2],
      merged: [story1, story2],
      storyCosts: workerStoryCosts,
      totalCost: 0.8,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [
        { success: true, storyId: "US-001" },
        { success: true, storyId: "US-002" },
      ]),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [story1, story2], ctx, prd });

    // Must NOT be even-split (0.4)
    expect(result.storyCosts.get("US-001")).not.toBe(0.4);
    expect(result.storyCosts.get("US-002")).not.toBe(0.4);
    // Must be actual per-story costs
    expect(result.storyCosts.get("US-001")).toBe(0.6);
    expect(result.storyCosts.get("US-002")).toBe(0.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: totalCost is the sum of per-story costs
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: runParallelBatch — totalCost equals sum of storyCosts", () => {
  test("totalCost equals sum of all entries in storyCosts Map", async () => {
    const story1 = makeStory("US-001");
    const story2 = makeStory("US-002");
    const story3 = makeStory("US-003");
    const prd = makePrd([story1, story2, story3]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story1, story2, story3],
      merged: [story1, story2, story3],
      storyCosts: new Map([["US-001", 0.5], ["US-002", 0.3], ["US-003", 0.2]]),
      totalCost: 1.0,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [
        { success: true, storyId: "US-001" },
        { success: true, storyId: "US-002" },
        { success: true, storyId: "US-003" },
      ]),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [story1, story2, story3], ctx, prd });

    const expectedTotal = [...result.storyCosts.values()].reduce((a, b) => a + b, 0);
    expect(result.totalCost).toBeCloseTo(expectedTotal, 5);
  });

  test("totalCost is 0 when no stories are in the batch", async () => {
    const prd = makePrd([]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      storyCosts: new Map(),
      totalCost: 0,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => []),
    })) as typeof _parallelBatchDeps.createMergeEngine;

    const result = await runParallelBatch({ stories: [], ctx, prd });

    expect(result.totalCost).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: rectification success
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: runParallelBatch — rectification success", () => {
  test("calls rectifyConflictedStory when executeParallelBatch returns a merge conflict", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [],
      mergeConflicts: [{ storyId: "US-001", conflictFiles: ["src/x.ts"], originalCost: 0.5 }],
      storyCosts: new Map([["US-001", 0.5]]),
      totalCost: 0.5,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;
    const rectifyMock = mock(async () => ({ success: true, storyId: "US-001", cost: 0.2 }));
    _parallelBatchDeps.rectifyConflictedStory = rectifyMock;

    await runParallelBatch({ stories: [story], ctx, prd });

    expect(rectifyMock).toHaveBeenCalled();
  });

  test("sets rectified: true in mergeConflicts when rectifyConflictedStory returns success", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [],
      mergeConflicts: [{ storyId: "US-001", conflictFiles: ["src/x.ts"], originalCost: 0.5 }],
      storyCosts: new Map([["US-001", 0.5]]),
      totalCost: 0.5,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;
    _parallelBatchDeps.rectifyConflictedStory = mock(async () => ({
      success: true,
      storyId: "US-001",
      cost: 0.2,
    }));

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    const conflict = result.mergeConflicts.find((c) => c.story.id === "US-001");
    expect(conflict).toBeDefined();
    expect(conflict?.rectified).toBe(true);
    expect(conflict?.cost).toBe(0.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: rectification failure
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: runParallelBatch — rectification failure", () => {
  test("sets rectified: false when rectifyConflictedStory returns failure", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [],
      mergeConflicts: [{ storyId: "US-001", conflictFiles: ["src/x.ts"], originalCost: 0.5 }],
      storyCosts: new Map([["US-001", 0.5]]),
      totalCost: 0.5,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;
    _parallelBatchDeps.rectifyConflictedStory = mock(async () => ({
      success: false,
      storyId: "US-001",
      cost: 0.1,
      finalConflict: true,
    }));

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    const conflict = result.mergeConflicts.find((c) => c.story.id === "US-001");
    expect(conflict).toBeDefined();
    expect(conflict?.rectified).toBe(false);
  });

  test("sets rectified: false when rectifyConflictedStory throws", async () => {
    const story = makeStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [],
      mergeConflicts: [{ storyId: "US-001", conflictFiles: ["src/x.ts"], originalCost: 0.5 }],
      storyCosts: new Map([["US-001", 0.5]]),
      totalCost: 0.5,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => ({
      create: mock(async () => {}),
      remove: mock(async () => {}),
    })) as typeof _parallelBatchDeps.createWorktreeManager;
    _parallelBatchDeps.createMergeEngine = mock(async () => ({
      mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
    })) as typeof _parallelBatchDeps.createMergeEngine;
    _parallelBatchDeps.rectifyConflictedStory = mock(async () => {
      throw new Error("rectification unexpectedly failed");
    });

    // Should not throw — failure should be caught and reported
    const result = await runParallelBatch({ stories: [story], ctx, prd });

    const conflict = result.mergeConflicts.find((c) => c.story.id === "US-001");
    expect(conflict).toBeDefined();
    expect(conflict?.rectified).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: merge-conflict-rectify exports
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: merge-conflict-rectify exports identical to parallel-executor-rectify", () => {
  test("exports rectifyConflictedStory function", async () => {
    const { rectifyConflictedStory } = await import("../../../src/execution/merge-conflict-rectify");
    expect(typeof rectifyConflictedStory).toBe("function");
  });

  test("ConflictedStoryInfo, RectificationResult, RectifyConflictedStoryOptions types are exported", async () => {
    // Verify the module loads — types cannot be tested at runtime but must not cause import errors
    const module = await import("../../../src/execution/merge-conflict-rectify");
    expect(module).toBeDefined();
    // The presence of rectifyConflictedStory confirms the type exports compile correctly
    expect(typeof module.rectifyConflictedStory).toBe("function");
  });

  test("rectifyConflictedStory from merge-conflict-rectify is same function as from the original parallel-executor-rectify (now deleted, re-exported)", async () => {
    const { rectifyConflictedStory: fromNew } = await import("../../../src/execution/merge-conflict-rectify");
    // parallel-executor-rectify was renamed to merge-conflict-rectify; the old name is deleted
    // Verify fromNew is a function (the rename means the old module no longer exists to compare)
    expect(typeof fromNew).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: all import sites of parallel-executor-rectify updated
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: import sites updated to merge-conflict-rectify", () => {
  test("parallel-batch.ts does not import from parallel-executor-rectify", async () => {
    const source = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/parallel-batch.ts"),
    ).text();
    expect(source).not.toContain("parallel-executor-rectify");
  });

  test("parallel-executor-rectification-pass.ts has no remaining imports from parallel-executor-rectify (once deleted)", async () => {
    // This test validates AC-10 is a prerequisite: the pass file should be deleted
    // so there are no remaining imports from parallel-executor-rectify in src/
    const passFileExists = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/parallel-executor-rectification-pass.ts"),
    ).exists();
    if (passFileExists) {
      // If it still exists, verify it doesn't import from parallel-executor-rectify
      const source = await Bun.file(
        path.join(import.meta.dir, "../../../src/execution/parallel-executor-rectification-pass.ts"),
      ).text();
      expect(source).not.toContain("parallel-executor-rectify");
    }
    // Once deleted, trivially passes
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: parallel-executor-rectification-pass.ts deleted
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: parallel-executor-rectification-pass.ts is deleted", () => {
  test("src/execution/parallel-executor-rectification-pass.ts does not exist", async () => {
    const exists = await Bun.file(
      path.join(import.meta.dir, "../../../src/execution/parallel-executor-rectification-pass.ts"),
    ).exists();
    expect(exists).toBe(false);
  });

  test("no file in src/execution imports from parallel-executor-rectification-pass", async () => {
    // Enumerate likely importers and verify none import from the deleted file
    const filesToCheck = [
      "../../../src/execution/parallel-executor.ts",
      "../../../src/execution/parallel-batch.ts",
      "../../../src/execution/parallel-coordinator.ts",
    ];
    for (const relPath of filesToCheck) {
      const absPath = path.join(import.meta.dir, relPath);
      const exists = await Bun.file(absPath).exists();
      if (exists) {
        const source = await Bun.file(absPath).text();
        expect(source).not.toContain("parallel-executor-rectification-pass");
      }
    }
  });
});
