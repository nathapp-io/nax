/**
 * Unit tests for src/execution/parallel-batch.ts — rectification context wiring.
 *
 * Split out of parallel-batch.test.ts (test-architecture.md: split by describe
 * block, not by bug number, once the parent file nears its line limit).
 *
 * Covers:
 *   BUG-36 — rectifyConflictedStory is called with the same worktree-pipeline
 *            base object the worker ran with (skipPrdPersistence, prdPath,
 *            featureDir all flow through instead of a hand-rolled subset).
 *   BUG-37 — a rectified story's re-run cost (mergeConflicts[].cost) folds
 *            into the batch's totalCost, not just storyCosts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";
import type { RectifyConflictedStoryOptions } from "@/execution/merge-conflict-rectify";
import { type ParallelBatchCtx, _parallelBatchDeps, runParallelBatch } from "@/execution/parallel-batch";
import type { ParallelBatchResult } from "@/execution/parallel-worker";
import type { LoadedHooksConfig } from "@/hooks";
import type { PipelineContext } from "@/pipeline/types";
import type { PluginRegistry } from "@/plugins/registry";
import type { PRD, UserStory } from "@/prd/types";
import { makePRD, makeStory as makeSharedStory } from "@test/helpers";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

function makeConflictStory(id: string, opts: Partial<UserStory> = {}): UserStory {
  return makeSharedStory({
    id,
    title: `Story ${id}`,
    acceptanceCriteria: [`AC-1: ${id}`],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
    ...opts,
  } as Partial<UserStory>);
}

function makePrd(stories: UserStory[]): PRD {
  return makePRD({ feature: "test-feature", branchName: "feat/test", userStories: stories });
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
      rootConfig: DEFAULT_CONFIG as NaxConfig,
      prd: {} as PRD,
      hooks: {} as LoadedHooksConfig,
      plugins: {} as PluginRegistry,
      storyStartTime: new Date().toISOString(),
    } as unknown as Omit<PipelineContext, "story" | "stories" | "workdir" | "routing">,
  };
}

let tmpDir: string;
let origDeps: typeof _parallelBatchDeps;

beforeEach(() => {
  tmpDir = makeTempDir("nax-pb-rect-ctx-");
  origDeps = { ..._parallelBatchDeps };
});

afterEach(() => {
  Object.assign(_parallelBatchDeps, origDeps);
  cleanupTempDir(tmpDir);
  mock.restore();
});

describe("BUG-36: rectification reuses the worker's worktree-pipeline base", () => {
  test("rectifyConflictedStory is called with pipelineContextBase === ctx.pipelineContext", async () => {
    const story = makeConflictStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);
    // Distinguish this ctx's base from a default one so the assertion below
    // actually proves identity, not two structurally-equal-by-accident objects.
    (ctx.pipelineContext as { prdPath?: string }).prdPath = "/real/feature/prd.json";
    (ctx.pipelineContext as { featureDir?: string }).featureDir = "/real/feature";
    (ctx.pipelineContext as { skipPrdPersistence?: boolean }).skipPrdPersistence = true;

    // mergeConflicts left empty here — the one real conflict entry comes from the
    // mocked mergeEngine.mergeAll() below (pipelinePassed + a failed merge result).
    // Pre-populating both would double-push the same story into mergeConflicts
    // and call rectifyConflictedStory twice, which the identity assertion below
    // isn't testing for — toHaveBeenCalledTimes(1) guards against that drift.
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [],
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
    const rectifyMock = mock((_opts: RectifyConflictedStoryOptions) =>
      Promise.resolve({ success: true as const, storyId: "US-001", cost: 0.2 }),
    );
    _parallelBatchDeps.rectifyConflictedStory = rectifyMock;

    await runParallelBatch({ stories: [story], ctx, prd });

    expect(rectifyMock).toHaveBeenCalledTimes(1);
    const [call] = rectifyMock.mock.calls;
    expect(call?.[0].pipelineContextBase).toBe(ctx.pipelineContext);
  });
});

describe("BUG-37: batch totalCost folds in rectification spend", () => {
  test("totalCost includes mergeConflicts[].cost, not just storyCosts", async () => {
    const story = makeConflictStory("US-001");
    const prd = makePrd([story]);
    const ctx = makeCtx(tmpDir);

    // storyCosts only carries the pre-conflict worker cost — the rectification
    // agent's own spend lands solely in mergeConflicts[].cost via rectifyConflictedStory.
    // (mergeConflicts left empty — see the identical note in the BUG-36 test above.)
    const workerResult = makeWorkerBatchResult({
      pipelinePassed: [story],
      merged: [],
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
    _parallelBatchDeps.rectifyConflictedStory = mock((_opts: RectifyConflictedStoryOptions) =>
      Promise.resolve({
        success: true as const,
        storyId: "US-001",
        cost: 0.35, // rectification's own re-run cost, distinct from the 0.5 worker cost
      }),
    );

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.totalCost).toBeCloseTo(0.85, 5);
  });
});
