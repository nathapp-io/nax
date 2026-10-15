import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMergeEngine,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStory,
  makeTempDir,
  makeTestContext,
  makeWorktreeManager,
} from "@test/helpers";
import { _parallelBatchDeps, type ParallelBatchCtx, runParallelBatch } from "@/execution/parallel-batch";
import type { NaxStatusFile } from "@/execution/status-file";
import { StatusWriter } from "@/execution/status-writer";

const originalDeps = { ..._parallelBatchDeps };
const config = makeNaxConfig();
const stories = [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })];
const prd = makePRD({ userStories: stories });
let dir: string;
let writers: StatusWriter[];
beforeEach(() => {
  dir = makeTempDir("parallel-active-");
  writers = [];
  _parallelBatchDeps.createWorktreeManager = async () => makeWorktreeManager();
  _parallelBatchDeps.createMergeEngine = async () => makeMergeEngine();
  _parallelBatchDeps.prepareWorktreeDependencies = async ({ worktreeRoot }) => ({ cwd: worktreeRoot });
  _parallelBatchDeps.executeParallelBatch = mock(async () => ({
    pipelinePassed: [],
    merged: [],
    failed: [],
    totalCost: 0,
    mergeConflicts: [],
    storyCosts: new Map(),
  }));
});
afterEach(async () => {
  Object.assign(_parallelBatchDeps, originalDeps);
  await Promise.all(writers.map((writer) => writer.idle()));
  cleanupTempDir(dir);
  mock.restore();
});

async function persisted(set = true): Promise<NaxStatusFile> {
  const path = join(dir, "status.json");
  const writer = new StatusWriter(path, config, {
    runId: "test",
    feature: "test",
    startedAt: new Date().toISOString(),
    dryRun: false,
    startTimeMs: Date.now(),
    pid: process.pid,
  });
  writers.push(writer);
  writer.setPrd(prd);
  await writer.update(0, 1);
  if (set)
    writer.setParallel({
      enabled: true,
      maxConcurrency: 3,
      activeStories: [{ storyId: "US-001", worktreePath: "/w/.nax-wt/a" }],
    });
  await writer.idle();
  return Bun.file(path).json();
}

describe("StatusWriter parallel persistence", () => {
  test("AC-1 persists activeStories without another update", async () => {
    expect((await persisted()).parallel?.activeStories).toEqual([{ storyId: "US-001", worktreePath: "/w/.nax-wt/a" }]);
  });
  test("AC-2 persists maxConcurrency", async () => {
    expect((await persisted()).parallel?.maxConcurrency).toBe(3);
  });
  test("AC-3 persists enabled", async () => {
    expect((await persisted()).parallel?.enabled).toBe(true);
  });
  test("AC-4 omits parallel until set", async () => {
    expect(await persisted(false)).not.toHaveProperty("parallel");
  });
});

function context(onActiveStories: NonNullable<ParallelBatchCtx["onActiveStories"]>): ParallelBatchCtx {
  return {
    workdir: dir,
    config,
    hooks: { hooks: {} },
    pluginRegistry: makePluginRegistry(),
    maxConcurrency: 2,
    pipelineContext: makeTestContext({ config, prd }),
    onActiveStories,
  };
}

const workerError = new Error("worker failed");
describe("ready-worker active notifications", () => {
  test("AC-5/6 reports prepared pairs before workers and clears before merge", async () => {
    const notify = mock<NonNullable<ParallelBatchCtx["onActiveStories"]>>(() => {});
    const execute = _parallelBatchDeps.executeParallelBatch;
    _parallelBatchDeps.executeParallelBatch = async (...args) => {
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]).toEqual([
        stories.map((story) => ({ storyId: story.id, worktreePath: expect.any(String) })),
      ]);
      expect(notify.mock.calls[0]?.[0].map((active) => active.worktreePath)).toEqual([...args[4].values()]);
      return execute(...args);
    };
    _parallelBatchDeps.createMergeEngine = async () => {
      expect(notify).toHaveBeenLastCalledWith([]);
      return makeMergeEngine();
    };
    await runParallelBatch({ stories, prd, ctx: context(notify) });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith([]);
  });
  test("AC-7/8 clears before propagating the identical worker error", async () => {
    const notify = mock<NonNullable<ParallelBatchCtx["onActiveStories"]>>(() => {});
    _parallelBatchDeps.executeParallelBatch = async () => {
      throw workerError;
    };
    let caught: unknown;
    try {
      await runParallelBatch({ stories, prd, ctx: context(notify) });
    } catch (error) {
      caught = error;
    }
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith([]);
    expect(caught).toBe(workerError);
  });
  test("AC-9 excludes both missing worktrees and dependency preparation failures", async () => {
    const missing = makeStory({ id: "US-003" });
    _parallelBatchDeps.createWorktreeManager = async () =>
      makeWorktreeManager({
        create: mock(async (_root: string, id: string) => {
          if (id.endsWith(missing.id)) throw new Error("no worktree");
        }),
      });
    _parallelBatchDeps.prepareWorktreeDependencies = async ({ storyId, worktreeRoot }) => {
      if (storyId === stories[1].id) throw new Error("dependencies failed");
      return { cwd: worktreeRoot };
    };
    const notify = mock<NonNullable<ParallelBatchCtx["onActiveStories"]>>(() => {});
    await runParallelBatch({ stories: [...stories, missing], prd, ctx: context(notify) });
    expect(notify.mock.calls[0]).toEqual([
      [{ storyId: stories[0].id, worktreePath: expect.stringContaining(".nax-wt/") }],
    ]);
  });
  test("AC-10 emits exactly two empty lists when no story is ready", async () => {
    _parallelBatchDeps.prepareWorktreeDependencies = async () => {
      throw new Error("not ready");
    };
    const notify = mock<NonNullable<ParallelBatchCtx["onActiveStories"]>>(() => {});
    await runParallelBatch({ stories, prd, ctx: context(notify) });
    expect(notify.mock.calls).toEqual([[[]], [[]]]);
    expect(_parallelBatchDeps.executeParallelBatch).not.toHaveBeenCalled();
  });
});
