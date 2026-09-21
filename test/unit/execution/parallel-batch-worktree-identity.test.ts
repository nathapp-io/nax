/**
 * US-003 — runParallelBatch derives the worktree identity.
 *
 * `runParallelBatch` used to hand the RAW story ID to `WorktreeManager.create`,
 * build `.nax-wt/<storyId>` by hand, and pass the raw ID to
 * `MergeEngine.mergeAll`. US-002 narrowed the worktree API to the branded
 * `WorktreeId`, so the batch must now compose
 * `deriveStoryWorktreeId(prd.feature, story.id)` per story — while the values
 * the rest of the run joins on (`completed`, `storyCosts`, and the per-story
 * metrics) keep the RAW story ID.
 *
 * Every test drives the real `runParallelBatch`; only its injectable deps
 * (worktree manager, merge engine, worker, dependency prep) are stubbed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMergeEngine,
  makePluginRegistry,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestContext,
  makeWorktreeManager,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _parallelBatchDeps, type ParallelBatchCtx, runParallelBatch } from "@/execution/parallel-batch";
import type { ParallelBatchResult } from "@/execution/parallel-worker";
import type { PRD, UserStory } from "@/prd/types";
import type { WorktreeId } from "@/worktree";

const FEATURE = "f";
const STORY_ID = "US-001";
/**
 * `deriveStoryWorktreeId("f", "US-001")`, spelled out literally so the pin is
 * independent of the producer it is checking.
 */
const COMPOSED_ID = "story-f-US-001";
/** The `.nax-wt/...` tail every composed worktree path must end with. */
const COMPOSED_TAIL = join(".nax-wt", "story-f-US-001");

/** One story in, one composed identity out — the `{ storyId, worktreeId }` pair. */
interface MergeAllArg {
  storyId: string;
  worktreeId: WorktreeId;
}

function emptyBatchResult(overrides: Partial<ParallelBatchResult> = {}): ParallelBatchResult {
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

describe("US-003 runParallelBatch derives the worktree identity (AC-1, AC-2, AC-3, AC-4)", () => {
  let tmpDir: string;
  let savedDeps: typeof _parallelBatchDeps;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-us003-parallel-batch-");
    savedDeps = { ..._parallelBatchDeps };
    // The batch prepares dependencies inside a worktree directory that the
    // (stubbed) manager never actually creates, and resolves per-package
    // configs from disk. Both are I/O boundaries — stub them so the batch
    // runs hermetically and every story reaches the worker.
    _parallelBatchDeps.prepareWorktreeDependencies = async ({ worktreeRoot }) => ({ cwd: worktreeRoot });
    _parallelBatchDeps.loadConfigForWorkdir = async () => DEFAULT_CONFIG;
  });

  afterEach(() => {
    Object.assign(_parallelBatchDeps, savedDeps);
    cleanupTempDir(tmpDir);
  });

  function makeBatchCtx(story: UserStory, feature = FEATURE): { ctx: ParallelBatchCtx; prd: PRD } {
    const prd = makePRD({ feature, userStories: [story] });
    const ctx: ParallelBatchCtx = {
      workdir: tmpDir,
      config: DEFAULT_CONFIG,
      hooks: { hooks: {} },
      pluginRegistry: makePluginRegistry(),
      maxConcurrency: 2,
      pipelineContext: makeTestContext({ config: DEFAULT_CONFIG, prd }),
    };
    return { ctx, prd };
  }

  test("AC-1: WorktreeManager.create receives the WorktreeId story-f-US-001, not the raw story ID", async () => {
    const story = makeStory({ id: STORY_ID });
    const { ctx, prd } = makeBatchCtx(story);

    const createCalls: Array<[string, string]> = [];
    const manager = makeWorktreeManager({
      create: mock(async (projectRoot: string, worktreeId: WorktreeId) => {
        createCalls.push([projectRoot, String(worktreeId)]);
      }),
    });
    _parallelBatchDeps.createWorktreeManager = mock(async () => manager);
    _parallelBatchDeps.executeParallelBatch = async () => emptyBatchResult();
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine());

    await runParallelBatch({ stories: [story], ctx, prd });

    expect(createCalls.length).toBe(1);
    expect(createCalls[0]?.[0]).toBe(tmpDir);
    expect(createCalls[0]?.[1]).toBe(COMPOSED_ID);
    expect(createCalls[0]?.[1]).not.toBe(STORY_ID);
  });

  test("AC-1 (boundary): a feature name outside the identity alphabet is sanitized, not interpolated raw", async () => {
    // "feat/one" cannot appear in a branch name verbatim. Deriving through the
    // US-001 producer sanitizes it to `story-feat-one-US-001`; a hand-rolled
    // `story-${feature}-${storyId}` interpolation would produce a slash and
    // escape the .nax-wt directory.
    const story = makeStory({ id: STORY_ID });
    const { ctx, prd } = makeBatchCtx(story, "feat/one");

    const createCalls: string[] = [];
    const manager = makeWorktreeManager({
      create: mock(async (_projectRoot: string, worktreeId: WorktreeId) => {
        createCalls.push(String(worktreeId));
      }),
    });
    _parallelBatchDeps.createWorktreeManager = mock(async () => manager);
    _parallelBatchDeps.executeParallelBatch = async () => emptyBatchResult();
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine());

    await runParallelBatch({ stories: [story], ctx, prd });

    expect(createCalls).toEqual(["story-feat-one-US-001"]);
  });

  test("AC-2: worktreePaths maps the raw story ID to a path ending in .nax-wt/story-f-US-001", async () => {
    const story = makeStory({ id: STORY_ID });
    const { ctx, prd } = makeBatchCtx(story);

    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    let observedPaths: Map<string, string> | undefined;
    _parallelBatchDeps.executeParallelBatch = async (_stories, _root, _config, _context, worktreePaths) => {
      observedPaths = worktreePaths;
      return emptyBatchResult();
    };
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine());

    await runParallelBatch({ stories: [story], ctx, prd });

    // Key: the raw story ID (the worker looks the path up by `story.id`).
    expect(observedPaths?.size).toBe(1);
    expect(observedPaths?.has(STORY_ID)).toBe(true);
    // Value: the composed worktree path.
    const worktreeRoot = observedPaths?.get(STORY_ID);
    expect(worktreeRoot?.endsWith(COMPOSED_TAIL)).toBe(true);
    expect(worktreeRoot?.endsWith(join(".nax-wt", STORY_ID))).toBe(false);
  });

  test("AC-3: the completed list contains the story keyed by its raw story ID", async () => {
    const story = makeStory({ id: STORY_ID });
    const { ctx, prd } = makeBatchCtx(story);

    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.executeParallelBatch = async () =>
      emptyBatchResult({ pipelinePassed: [story], storyCosts: new Map([[STORY_ID, 0.42]]) });
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({ mergeAll: mock(async () => [{ success: true, storyId: STORY_ID }]) }),
    );

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.completed.map((s) => s.id)).toEqual([STORY_ID]);
    expect(result.completed.some((s) => s.id === COMPOSED_ID)).toBe(false);
  });

  test("mergeAll receives the composed identity per story, keyed by raw story ID", async () => {
    const story = makeStory({ id: STORY_ID });
    const { ctx, prd } = makeBatchCtx(story);

    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.executeParallelBatch = async () =>
      emptyBatchResult({ pipelinePassed: [story], storyCosts: new Map([[STORY_ID, 0.42]]) });
    let mergeAllArg: ReadonlyArray<MergeAllArg> | undefined;
    _parallelBatchDeps.createMergeEngine = mock(async () =>
      makeMergeEngine({
        mergeAll: mock(async (_root: string, stories: ReadonlyArray<MergeAllArg>) => {
          mergeAllArg = stories;
          return [{ success: true, storyId: STORY_ID }];
        }),
      }),
    );

    await runParallelBatch({ stories: [story], ctx, prd });

    expect(mergeAllArg?.length).toBe(1);
    // The merge key stays raw (StoryDependencies is keyed by raw story ID)…
    expect(mergeAllArg?.[0]?.storyId).toBe(STORY_ID);
    // …while the branch it merges is the composed identity.
    expect(String(mergeAllArg?.[0]?.worktreeId)).toBe(COMPOSED_ID);
  });

  test("AC-4: storyCosts is keyed by the raw story ID US-001, never the composed identity", async () => {
    const story = makeStory({ id: STORY_ID });
    const { ctx, prd } = makeBatchCtx(story);

    _parallelBatchDeps.createWorktreeManager = mock(async () => makeWorktreeManager());
    _parallelBatchDeps.executeParallelBatch = async () => emptyBatchResult({ storyCosts: new Map([[STORY_ID, 0.5]]) });
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine());

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(result.storyCosts.get(STORY_ID)).toBe(0.5);
    expect(result.storyCosts.has(COMPOSED_ID)).toBe(false);
    expect(result.totalCost).toBe(0.5);
  });

  test("boundary: a worktree-create failure is reported under the raw story ID and leaves the batch alive", async () => {
    // The failure path keys its synthesized result by `story.id`; composing the
    // identity must not leak into the failure bookkeeping either.
    const story = makeStory({ id: STORY_ID });
    const { ctx, prd } = makeBatchCtx(story);

    const manager = makeWorktreeManager({
      create: mock(async () => {
        throw new Error("git worktree add failed");
      }),
    });
    _parallelBatchDeps.createWorktreeManager = mock(async () => manager);
    let workerCalled = false;
    _parallelBatchDeps.executeParallelBatch = async () => {
      workerCalled = true;
      return emptyBatchResult();
    };
    _parallelBatchDeps.createMergeEngine = mock(async () => makeMergeEngine());

    const result = await runParallelBatch({ stories: [story], ctx, prd });

    expect(workerCalled).toBe(false);
    expect(result.completed).toEqual([]);
    expect(result.failed.map((f) => f.story.id)).toEqual([STORY_ID]);
    expect(result.failed[0]?.pipelineResult.reason).toContain("git worktree add failed");
  });
});
