/**
 * Unit tests for src/execution/parallel-batch.ts structure and wiring.
 *
 * Merged from three files that all pin `runParallelBatch`:
 *   - structural / type-export assertions for the parallel batch and
 *     rectification modules (exec AC-26, rect AC-8a/8b/9/10)
 *   - US-003: runParallelBatch derives the worktree identity (AC-1 … AC-4)
 *   - BUG-36/BUG-37: rectification context wiring and cost folding
 *
 * The original ticket files were `parallel-batch-worktree-identity.test.ts`
 * and `parallel-batch-rectification-context.test.ts`.
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
import { DEFAULT_CONFIG } from "@/config";
import type { RectifyConflictedStoryOptions } from "@/execution/merge-conflict-rectify";
import { _parallelBatchDeps, type ParallelBatchCtx, runParallelBatch } from "@/execution/parallel-batch";
import type { ParallelBatchResult } from "@/execution/parallel-worker";
import type { LoadedHooksConfig } from "@/hooks";
import type { PluginRegistry } from "@/plugins/registry";
import type { PRD, UserStory } from "@/prd/types";
import { MergeEngine, type WorktreeId, WorktreeManager } from "@/worktree";

const SRC = join(import.meta.dir, "../../../src");

// ─────────────────────────────────────────────────────────────────────────────
// exec AC-26 — parallel-executor.ts must not exist and must not be imported
// ─────────────────────────────────────────────────────────────────────────────

describe("exec AC-26: src/execution/parallel-executor.ts does not exist", () => {
  test("AC-26: parallel-executor.ts file is absent", async () => {
    const exists = await Bun.file(join(SRC, "execution/parallel-executor.ts")).exists();
    expect(exists).toBe(false);
  });

  test("AC-26: no src/ file imports from parallel-executor", async () => {
    const offenders: string[] = [];
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: false });
    for (const file of files) {
      const content = await Bun.file(join(SRC, file)).text();
      if (
        content.includes("parallel-executor") &&
        !content.includes("parallel-executor-rectify") &&
        !content.includes("parallel-executor-rectification-pass")
      ) {
        offenders.push(file);
      }
    }
    // The only match for "parallel-executor" (without the more-specific suffixes) should be none
    // Filter out any test files that may reference it
    const srcOffenders = offenders.filter((f) => !f.includes("test/"));
    expect(srcOffenders).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-9 — no src file imports from parallel-executor-rectify
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-9: no src/ file imports from parallel-executor-rectify", () => {
  test("AC-9: src/execution has no imports from parallel-executor-rectify", async () => {
    const executionDir = join(SRC, "execution");
    const offenders: string[] = [];
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: executionDir, absolute: false });
    for (const file of files) {
      const content = await Bun.file(join(executionDir, file)).text();
      if (content.includes("parallel-executor-rectify")) {
        offenders.push(file);
      }
    }
    expect(offenders).toHaveLength(0);
  });

  test("AC-9: no src/ file anywhere imports from parallel-executor-rectify", async () => {
    const offenders: string[] = [];
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: false });
    for (const file of files) {
      const content = await Bun.file(join(SRC, file)).text();
      if (content.includes("parallel-executor-rectify")) {
        offenders.push(file);
      }
    }
    expect(offenders).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-10 — no src file imports from parallel-executor-rectification-pass
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-10: no src/ file imports from parallel-executor-rectification-pass", () => {
  test("AC-10: src/execution has no imports from parallel-executor-rectification-pass", async () => {
    const executionDir = join(SRC, "execution");
    const offenders: string[] = [];
    const files = new Bun.Glob("**/*.ts").scanSync({ cwd: executionDir, absolute: false });
    for (const file of files) {
      const content = await Bun.file(join(executionDir, file)).text();
      if (content.includes("parallel-executor-rectification-pass")) {
        offenders.push(file);
      }
    }
    expect(offenders).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-8a — RectificationResult exported from merge-conflict-rectify with union shape
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-8a: RectificationResult exported from merge-conflict-rectify with correct shape", () => {
  test("AC-8a: RectificationResult type compiles — success variant has storyId + cost fields", async () => {
    const { rectifyConflictedStory } = await import("@/execution/merge-conflict-rectify");
    // Confirm module loaded; type exports verified by TypeScript compilation
    expect(typeof rectifyConflictedStory).toBe("function");

    // Runtime shape check via source: assert the success/failure union fields exist in source
    const source = await Bun.file(join(SRC, "execution/merge-conflict-rectify.ts")).text();
    expect(source).toContain("RectificationResult");
    // success union variant
    expect(source).toMatch(/success\s*:\s*true.*storyId.*cost/s);
    // failure union variant
    expect(source).toMatch(/success\s*:\s*false.*storyId.*cost.*finalConflict/s);
  });

  test("AC-8a: RectificationResult success-true literal satisfies the exported type at compile time", () => {
    // TypeScript will reject this file if the import type is wrong — compile-time verification
    type RectificationResult = import("@/execution/merge-conflict-rectify").RectificationResult;
    const success: RectificationResult = { success: true, storyId: "US-001", cost: 1.5 };
    expect(success.success).toBe(true);
    expect(success.storyId).toBe("US-001");
    expect(success.cost).toBe(1.5);
  });

  test("AC-8a: RectificationResult failure literal satisfies the exported type at compile time", () => {
    type RectificationResult = import("@/execution/merge-conflict-rectify").RectificationResult;
    const failure: RectificationResult = { success: false, storyId: "US-001", cost: 0, finalConflict: true };
    expect(failure.success).toBe(false);
    expect(failure.storyId).toBe("US-001");
    expect(failure.finalConflict).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-8b — RectifyConflictedStoryOptions exported from merge-conflict-rectify
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-8b: RectifyConflictedStoryOptions exported from merge-conflict-rectify", () => {
  test("AC-8b: RectifyConflictedStoryOptions type is present in source with required fields", async () => {
    const source = await Bun.file(join(SRC, "execution/merge-conflict-rectify.ts")).text();
    expect(source).toContain("RectifyConflictedStoryOptions");
    // Must include fields from ConflictedStoryInfo + DispatchContext + workdir/config/hooks/prd
    expect(source).toContain("storyId");
    expect(source).toContain("workdir");
    expect(source).toContain("config");
    expect(source).toContain("hooks");
    expect(source).toContain("prd");
  });

  test("AC-8b: module exports RectifyConflictedStoryOptions (confirmed via rectifyConflictedStory function signature accepting it)", async () => {
    // The function accepting RectifyConflictedStoryOptions is rectifyConflictedStory — its existence
    // at runtime proves the type compiled and is exported
    const mod = await import("@/execution/merge-conflict-rectify");
    expect(typeof mod.rectifyConflictedStory).toBe("function");
    // The type export is confirmed at compile time: if RectifyConflictedStoryOptions were missing,
    // src/execution/parallel-batch.ts (which imports it) would fail to compile.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — runParallelBatch derives the worktree identity.
//
// `runParallelBatch` used to hand the RAW story ID to `WorktreeManager.create`,
// build `.nax-wt/<storyId>` by hand, and pass the raw ID to
// `MergeEngine.mergeAll`. US-002 narrowed the worktree API to the branded
// `WorktreeId`, so the batch must now compose
// `deriveStoryWorktreeId(prd.feature, story.id)` per story — while the values
// the rest of the run joins on (`completed`, `storyCosts`, and the per-story
// metrics) keep the RAW story ID.
//
// Every test drives the real `runParallelBatch`; only its injectable deps
// (worktree manager, merge engine, worker, dependency prep) are stubbed.
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// BUG-36/BUG-37 — rectification context wiring.
//
// Hook safety: the rectification `_deps` stubs are scoped inside this outer
// describe so they do not leak into the structure or US-003 tests above.
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeWorktreeManager(): WorktreeManager {
  const wm = new WorktreeManager();
  wm.create = mock(async () => {});
  wm.remove = mock(async () => {});
  return wm;
}

function makeFakeMergeEngine(worktreeManager: WorktreeManager, mergeAllImpl: MergeEngine["mergeAll"]): MergeEngine {
  const engine = new MergeEngine(worktreeManager);
  engine.mergeAll = mergeAllImpl;
  return engine;
}

function makeConflictStory(id: string, opts: Partial<UserStory> = {}): UserStory {
  return makeStory({
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
    config: DEFAULT_CONFIG,
    hooks: {} as LoadedHooksConfig,
    pluginRegistry: {} as PluginRegistry,
    maxConcurrency: 2,
    pipelineContext: makeTestContext({
      config: DEFAULT_CONFIG,
      rootConfig: DEFAULT_CONFIG,
      prd: {} as PRD,
      hooks: {} as LoadedHooksConfig,
      plugins: {} as PluginRegistry,
      storyStartTime: new Date().toISOString(),
    }),
  };
}

describe("parallel-batch rectification context (BUG-36, BUG-37)", () => {
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
      _parallelBatchDeps.createWorktreeManager = mock(async () => makeFakeWorktreeManager());
      _parallelBatchDeps.createMergeEngine = mock(async (worktreeManager: WorktreeManager) =>
        makeFakeMergeEngine(
          worktreeManager,
          mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
        ),
      );
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
      _parallelBatchDeps.createWorktreeManager = mock(async () => makeFakeWorktreeManager());
      _parallelBatchDeps.createMergeEngine = mock(async (worktreeManager: WorktreeManager) =>
        makeFakeMergeEngine(
          worktreeManager,
          mock(async () => [{ success: false, storyId: "US-001", conflictFiles: ["src/x.ts"] }]),
        ),
      );
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
});
