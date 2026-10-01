/**
 * Unit tests for src/execution/parallel-batch.ts
 *
 * Tests are intentionally in RED (failing) state — runParallelBatch is a stub.
 * The implementer must make these pass.
 *
 * Covers ACs 1–10 for US-001: Add parallel-batch.ts and rename rectify file.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMergeEngine,
  makePRD,
  makeStory as makeStoryBase,
  makeTempDir,
  makeTestContext,
  makeWorktreeManager,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type { RectificationResult } from "@/execution/merge-conflict-rectify";
import { _parallelBatchDeps, type ParallelBatchCtx, runParallelBatch } from "@/execution/parallel-batch";
import type { ParallelBatchResult } from "@/execution/parallel-worker";
import type { LoadedHooksConfig } from "@/hooks";
import type { PipelineRunResult } from "@/pipeline";
import type { PipelineContext } from "@/pipeline/types";
import type { PluginRegistry } from "@/plugins/registry";
import type { PRD, UserStory } from "@/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(id: string, opts: Partial<UserStory> = {}): UserStory {
  return makeStoryBase({
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [`AC-1: ${id}`],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
    ...opts,
  });
}

function makePrd(stories: UserStory[]): PRD {
  return makePRD({
    project: "test",
    feature: "test-feature",
    branchName: "feat/test",
    userStories: stories,
  });
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
    pipelineContext: makeTestContext({
      config: DEFAULT_CONFIG as NaxConfig,
      rootConfig: DEFAULT_CONFIG as NaxConfig,
      prd: {} as PRD,
      hooks: {} as LoadedHooksConfig,
      plugins: {} as PluginRegistry,
      storyStartTime: new Date().toISOString(),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test lifecycle
// ─────────────────────────────────────────────────────────────────name────────

let tmpDir: string;
let origDeps: typeof _parallelBatchDeps;

beforeEach(() => {
  tmpDir = makeTempDir("nax-pb-");
  origDeps = { ..._parallelBatchDeps };
});

afterEach(() => {
  Object.assign(_parallelBatchDeps, origDeps);
  cleanupTempDir(tmpDir);
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
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({ mergeAll: mock(async () => [{ success: true, storyId: "US-001" }]) }),
    );

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
      storyCosts: new Map([
        ["US-001", 0.3],
        ["US-002", 0.4],
      ]),
      totalCost: 0.7,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({ mergeAll: mock(async () => [{ success: true, storyId: "US-001" }]) }),
    );

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

    const _pipelineResult = makePipelineRunResult(false, "tests failed");
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [],
      merged: [],
      failed: [{ story, error: "tests failed" }],
      storyCosts: new Map([["US-001", 0.1]]),
      totalCost: 0.1,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine({ mergeAll: mock(async () => []) }));

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
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({ mergeAll: mock(async () => [{ success: true, storyId: "US-001" }]) }),
    );

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.failed).toEqual([]);
  });
});

describe("worktree dependency preparation", () => {
  test("prepares dependencies before executeParallelBatch runs", async () => {
    const story = makeStory("US-010", { workdir: "packages/app" });
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);
    const callOrder: string[] = [];

    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.prepareWorktreeDependencies = mock(async () => {
      callOrder.push("prepare");
      return { cwd: `${tmpDir}/.nax-wt/US-010/packages/app`, env: { PATH: "/tmp/bin" } };
    }) as typeof _parallelBatchDeps.prepareWorktreeDependencies;
    _parallelBatchDeps.executeParallelBatch = mock(async () => {
      callOrder.push("execute");
      return makeWorkerBatchResult();
    });

    await runParallelBatch({ stories: [story], ctx, prd });

    expect(callOrder).toEqual(["prepare", "execute"]);
  });

  // BUG-60 regression: a dependency-prep failure must record its own failure
  // timestamp, not fall back to batchEndMs (which would report a duration
  // spanning the whole batch's wall-clock time for what is really a
  // near-instant failure).
  test("records the actual failure moment for a dependency-prep failure, not batchEndMs", async () => {
    const failing = makeStory("US-011", { workdir: "packages/app" });
    const surviving = makeStory("US-012", { workdir: "packages/lib" });
    const prd = makePrd([failing, surviving]);
    const ctx = makeCtx(tmpDir);

    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());

    _parallelBatchDeps.prepareWorktreeDependencies = mock(async (opts: { storyId: string }) => {
      if (opts.storyId === "US-011") {
        throw new Error("dependency prep failed");
      }
      return { cwd: `${tmpDir}/.nax-wt/${opts.storyId}`, env: {} };
    }) as typeof _parallelBatchDeps.prepareWorktreeDependencies;

    _parallelBatchDeps.executeParallelBatch = mock(async () => {
      // Simulate the surviving story taking a while to execute — batchEndMs
      // is stamped well after the dependency-prep failure actually happened.
      await new Promise((r) => setTimeout(r, 50));
      return makeWorkerBatchResult({ pipelinePassed: [surviving], merged: [surviving] });
    });
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({ mergeAll: mock(async () => [{ success: true, storyId: "US-012" }]) }),
    );

    const result = await runParallelBatch({ stories: [failing, surviving], ctx, prd });

    expect(result.failed.some((f) => f.story.id === "US-011")).toBe(true);
    const failingDuration = result.storyDurations?.get("US-011") ?? 0;
    const survivingDuration = result.storyDurations?.get("US-012") ?? 0;
    // The failing story's duration must not stretch out to cover the batch's
    // full wall-clock time — it should be small (near-instant failure), well
    // under the surviving story's duration.
    expect(failingDuration).toBeLessThan(survivingDuration);
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

    // US-001 passed the pipeline; merge conflict is reported by mergeEngine.mergeAll (not pre-populated)
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [],
      mergeConflicts: [],
      storyCosts: new Map([["US-001", 0.5]]),
      totalCost: 0.5,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/foo.ts"] }]),
      }),
    );
    _parallelBatchDeps.rectifyConflictedStory = mock(
      async (): Promise<RectificationResult> => ({
        success: true,
        storyId: "US-001",
        cost: 0.2,
      }),
    );

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
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({ mergeAll: mock(async () => [{ success: true, storyId: "US-001" }]) }),
    );

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

    const workerStoryCosts = new Map([
      ["US-001", 0.5],
      ["US-002", 0.3],
    ]);
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story1, story2],
      merged: [story1, story2],
      storyCosts: workerStoryCosts,
      totalCost: 0.8,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [
          { success: true, storyId: "US-001" },
          { success: true, storyId: "US-002" },
        ]),
      }),
    );

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
    const workerStoryCosts = new Map([
      ["US-001", 0.6],
      ["US-002", 0.2],
    ]);
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story1, story2],
      merged: [story1, story2],
      storyCosts: workerStoryCosts,
      totalCost: 0.8,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [
          { success: true, storyId: "US-001" },
          { success: true, storyId: "US-002" },
        ]),
      }),
    );

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
      storyCosts: new Map([
        ["US-001", 0.5],
        ["US-002", 0.3],
        ["US-003", 0.2],
      ]),
      totalCost: 1.0,
    });

    _parallelBatchDeps.executeParallelBatch = mock(async () => workerResult);
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [
          { success: true, storyId: "US-001" },
          { success: true, storyId: "US-002" },
          { success: true, storyId: "US-003" },
        ]),
      }),
    );

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
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine({ mergeAll: mock(async () => []) }));

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
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
      }),
    );
    const rectifyMock = mock(
      async (): Promise<RectificationResult> => ({ success: true, storyId: "US-001", cost: 0.2 }),
    );
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
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
      }),
    );
    _parallelBatchDeps.rectifyConflictedStory = mock(
      async (): Promise<RectificationResult> => ({
        success: true,
        storyId: "US-001",
        cost: 0.2,
      }),
    );

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
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
      }),
    );
    _parallelBatchDeps.rectifyConflictedStory = mock(
      async (): Promise<RectificationResult> => ({
        success: false,
        storyId: "US-001",
        cost: 0.1,
        finalConflict: true,
      }),
    );

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
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
      }),
    );
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
    const { rectifyConflictedStory } = await import("@/execution/merge-conflict-rectify");
    expect(typeof rectifyConflictedStory).toBe("function");
  });

  test("ConflictedStoryInfo, RectificationResult, RectifyConflictedStoryOptions types are exported", async () => {
    // Verify the module loads — types cannot be tested at runtime but must not cause import errors
    const module = await import("@/execution/merge-conflict-rectify");
    expect(module).toBeDefined();
    // The presence of rectifyConflictedStory confirms the type exports compile correctly
    expect(typeof module.rectifyConflictedStory).toBe("function");
  });

  test("rectifyConflictedStory from merge-conflict-rectify is same function as from the original parallel-executor-rectify (now deleted, re-exported)", async () => {
    const { rectifyConflictedStory: fromNew } = await import("@/execution/merge-conflict-rectify");
    // parallel-executor-rectify was renamed to merge-conflict-rectify; the old name is deleted
    // Verify fromNew is a function (the rename means the old module no longer exists to compare)
    expect(typeof fromNew).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: all import sites of parallel-executor-rectify updated
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: import sites updated to merge-conflict-rectify", () => {
  test("parallel-batch.ts imports from merge-conflict-rectify and not the old module name", async () => {
    const source = await Bun.file(join(import.meta.dir, "../../../src/execution/parallel-batch.ts")).text();
    expect(source).toContain('import("./merge-conflict-rectify")');
  });

  test("no src/execution file imports from parallel-executor-rectify", async () => {
    const executionDir = join(import.meta.dir, "../../../src/execution");
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: executionDir });
    const offenders: string[] = [];
    for (const file of files) {
      const source = await Bun.file(join(executionDir, file)).text();
      if (source.includes("parallel-executor-rectify")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: parallel-executor-rectification-pass.ts deleted
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: parallel-executor-rectification-pass.ts is deleted", () => {
  test("src/execution/parallel-executor-rectification-pass.ts does not exist", async () => {
    const exists = await Bun.file(
      join(import.meta.dir, "../../../src/execution/parallel-executor-rectification-pass.ts"),
    ).exists();
    expect(exists).toBe(false);
  });

  test("no file in src/execution imports from parallel-executor-rectification-pass", async () => {
    const executionDir = join(import.meta.dir, "../../../src/execution");
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: executionDir });
    const offenders: string[] = [];
    for (const file of files) {
      const source = await Bun.file(join(executionDir, file)).text();
      if (source.includes("parallel-executor-rectification-pass")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-story config loading resilience (BUG-007)
// ─────────────────────────────────────────────────────────────────────────────

describe("per-story config loading — resilience", () => {
  test("config load failure for one story does not prevent the batch from running", async () => {
    const goodStory = makeStory("good", { workdir: "packages/good" });
    const badStory = makeStory("bad", { workdir: "packages/bad" });
    const prd = makePrd([goodStory, badStory]);
    const ctx = makeCtx(tmpDir);

    let configLoadCallCount = 0;
    _parallelBatchDeps.loadConfigForWorkdir = mock(
      async (_root: string, workdir?: string, _prof?: Record<string, unknown>) => {
        configLoadCallCount++;
        if (workdir === "packages/bad") throw new Error("Malformed per-package config");
        return DEFAULT_CONFIG as NaxConfig;
      },
    );
    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.executeParallelBatch = mock(async () =>
      makeWorkerBatchResult({ pipelinePassed: [goodStory, badStory], merged: [goodStory, badStory] }),
    );
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async () => [
          { success: true, storyId: "good" },
          { success: true, storyId: "bad" },
        ]),
      }),
    );

    let threwOnConfigLoad = false;
    try {
      await runParallelBatch({ stories: [goodStory, badStory], ctx, prd });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Malformed per-package config")) {
        threwOnConfigLoad = true;
      }
    }

    expect(threwOnConfigLoad).toBe(false);
    expect(configLoadCallCount).toBe(2);
  });
});
