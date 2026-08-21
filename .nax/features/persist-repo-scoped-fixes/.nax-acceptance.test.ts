import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { recordRepoScopedFixes } from "@/execution";
import { _executionDeps, executionStage } from "@/pipeline";
import type { PipelineContext } from "@/pipeline/types";
import { loadPRD, resetFailedStoriesToPending, savePRD } from "@/prd";
import type { PRD, UserStory } from "@/prd/types";
import { cleanupTempDir, makeAgentAdapter, makePRD, makeStory, makeTempDir, makeTestContext } from "@test/helpers";

type PersistedRepoScopedFix = {
  triggeringTests: readonly string[];
  filesChanged: readonly string[];
  findingsCleared: boolean | number;
};
type PersistedStory = UserStory & { repoScopedFixes?: PersistedRepoScopedFix[] };
type RepoScopedFixRecorder = (story: PersistedStory, records?: readonly PersistedRepoScopedFix[]) => undefined;
type ExecutionDepsWithRecorder = typeof _executionDeps & { recordRepoScopedFixes: RepoScopedFixRecorder };

const repoScopedFixes = (triggeringTests: string[], filesChanged: string[], findingsCleared: boolean | number) => [
  { triggeringTests, filesChanged, findingsCleared },
];

function makePersistedStory(overrides: Partial<PersistedStory> = {}): PersistedStory {
  return makeStory(overrides) as PersistedStory;
}

function makePersistedPrd(stories: PersistedStory[]): PRD {
  return makePRD({ userStories: stories });
}

function repoScopedFixRecorder(): RepoScopedFixRecorder {
  return recordRepoScopedFixes as unknown as RepoScopedFixRecorder;
}

function makePlanResult(repoScopedFixes?: PersistedRepoScopedFix[], success = true) {
  return {
    success,
    phaseCosts: {},
    totalCostUsd: 0,
    durationMs: 0,
    phaseOutputs: {},
    ...(repoScopedFixes === undefined ? {} : { repoScopedFixes }),
  };
}

function makeExecutionContext(story = makePersistedStory({ status: "in-progress" })): PipelineContext {
  const prd = makePersistedPrd([story]);
  return makeTestContext({
    story,
    stories: [story],
    prd,
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "",
      agent: "claude",
    },
    packageView: { select: () => ({}) } as PipelineContext["packageView"],
    runtime: { dispatchEvents: undefined } as PipelineContext["runtime"],
  });
}

let originalExecutionDeps: typeof _executionDeps;

beforeEach(() => {
  originalExecutionDeps = { ..._executionDeps };
  _executionDeps.getAgent = () => makeAgentAdapter({ name: "claude" });
  _executionDeps.validateAgentForTier = () => true;
  _executionDeps.assemblePlanInputsFromCtx = async () => ({}) as never;
  _executionDeps.applyPostRunInspection = async () => ({}) as never;
  _executionDeps.decideStageAction = () => ({ action: "continue" });
});

afterEach(() => {
  Object.assign(_executionDeps, originalExecutionDeps);
});

describe("persist-repo-scoped-fixes acceptance", () => {
  test("AC-1: persists repo-scoped fixes through savePRD and loadPRD", async () => {
    const tempDir = makeTempDir("nax-persist-repo-fixes-");
    const path = join(tempDir, "prd.json");
    const story = makePersistedStory({
      repoScopedFixes: repoScopedFixes(["a::t"], ["x.ts"], true),
    });

    try {
      await savePRD(makePersistedPrd([story]), path);
      const loadedStory = (await loadPRD(path)).userStories[0] as PersistedStory;
      expect(loadedStory.repoScopedFixes).toHaveLength(1);
      expect(loadedStory.repoScopedFixes?.[0]?.triggeringTests).toEqual(["a::t"]);
      expect(loadedStory.repoScopedFixes?.[0]?.filesChanged).toEqual(["x.ts"]);
      expect(loadedStory.repoScopedFixes?.[0]?.findingsCleared).toBe(true);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test("AC-2: preserves undefined when a saved story has no repoScopedFixes", async () => {
    const tempDir = makeTempDir("nax-persist-repo-fixes-");
    const path = join(tempDir, "prd.json");

    try {
      await savePRD(makePersistedPrd([makePersistedStory()]), path);
      const loadedStory = (await loadPRD(path)).userStories[0] as PersistedStory;
      expect(loadedStory.repoScopedFixes).toBeUndefined();
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  test("AC-3: resetRef clears repo-scoped fixes from every failed story", () => {
    const prd = makePersistedPrd([
      makePersistedStory({ status: "failed", repoScopedFixes: repoScopedFixes(["a::t"], ["x.ts"], false) }),
      makePersistedStory({ id: "US-002", status: "failed", repoScopedFixes: repoScopedFixes(["a::t"], ["x.ts"], false) }),
    ]);

    resetFailedStoriesToPending(prd, { resetRef: true });
    expect((prd.userStories[0] as PersistedStory).repoScopedFixes).toBeUndefined();
    expect((prd.userStories[1] as PersistedStory).repoScopedFixes).toBeUndefined();
  });

  test("AC-4: worktree isolation clears repo-scoped fixes from a failed story", () => {
    const story = makePersistedStory({
      status: "failed",
      repoScopedFixes: repoScopedFixes(["b::t"], ["y.ts"], true),
    });

    resetFailedStoriesToPending(makePersistedPrd([story]), { storyIsolation: "worktree" });
    expect(story.repoScopedFixes).toBeUndefined();
  });

  test("AC-5: an ordinary failed-story reset retains repo-scoped fixes", () => {
    const story = makePersistedStory({
      status: "failed",
      repoScopedFixes: repoScopedFixes(["c::t"], ["z.ts"], false),
    });

    resetFailedStoriesToPending(makePersistedPrd([story]), {});
    expect(story.repoScopedFixes).toHaveLength(1);
    expect(story.repoScopedFixes?.[0]?.triggeringTests).toEqual(["c::t"]);
    expect(story.repoScopedFixes?.[0]?.filesChanged).toEqual(["z.ts"]);
  });

  test("AC-6: resetRef preserves passed-story fixes while clearing failed-story fixes", () => {
    const passedStory = makePersistedStory({
      status: "passed",
      passes: true,
      repoScopedFixes: repoScopedFixes(["d::t"], ["w.ts"], true),
    });
    const failedStory = makePersistedStory({ id: "US-002", status: "failed", repoScopedFixes: repoScopedFixes(["a"], ["x.ts"], false) });

    resetFailedStoriesToPending(makePersistedPrd([passedStory, failedStory]), { resetRef: true });
    expect(passedStory.repoScopedFixes).toHaveLength(1);
    expect(passedStory.repoScopedFixes?.[0]?.triggeringTests).toEqual(["d::t"]);
    expect(passedStory.repoScopedFixes?.[0]?.filesChanged).toEqual(["w.ts"]);
    expect(passedStory.repoScopedFixes?.[0]?.findingsCleared).toBe(true);
    expect(failedStory.repoScopedFixes).toBeUndefined();
  });

  test("AC-7: records triggering tests, changed files, and findings-cleared count", () => {
    const story = makePersistedStory();
    const record = { triggeringTests: ["test-a.ts"], filesChanged: ["file-1.ts"], findingsCleared: 3 };

    repoScopedFixRecorder()(story, [record]);
    expect(story.repoScopedFixes).toHaveLength(1);
    expect(story.repoScopedFixes?.[0]?.triggeringTests).toEqual(["test-a.ts"]);
    expect(story.repoScopedFixes?.[0]?.filesChanged).toEqual(["file-1.ts"]);
    expect(story.repoScopedFixes?.[0]?.findingsCleared).toBe(3);
  });

  test("AC-8: records only the persisted repo-scoped-fix fields", () => {
    const story = makePersistedStory();
    const record = { declinedReason: "gave up", triggeringTests: ["t1"], filesChanged: ["f1"], findingsCleared: 1 };

    repoScopedFixRecorder()(story, [record]);
    expect(Object.keys(story.repoScopedFixes?.[0] ?? {})).toEqual(["triggeringTests", "filesChanged", "findingsCleared"]);
    expect(Object.keys(story.repoScopedFixes?.[0] ?? {})).not.toContain("declinedReason");
  });

  test("AC-9: records multiple entries in their original order", () => {
    const story = makePersistedStory();
    const record1 = { triggeringTests: ["test-1"], filesChanged: [], findingsCleared: 1 };
    const record2 = { triggeringTests: ["test-2"], filesChanged: [], findingsCleared: 2 };

    repoScopedFixRecorder()(story, [record1, record2]);
    expect(story.repoScopedFixes).toHaveLength(2);
    expect(story.repoScopedFixes?.[0]?.triggeringTests).toEqual(["test-1"]);
    expect(story.repoScopedFixes?.[1]?.triggeringTests).toEqual(["test-2"]);
  });

  test("AC-10: appends new records without replacing existing fixes", () => {
    const story = makePersistedStory({ repoScopedFixes: repoScopedFixes(["existing"], ["ex"], 1) });
    const newRecord = { triggeringTests: ["new"], filesChanged: ["nf"], findingsCleared: 2 };

    repoScopedFixRecorder()(story, [newRecord]);
    expect(story.repoScopedFixes).toHaveLength(2);
    expect(story.repoScopedFixes?.[0]?.triggeringTests).toEqual(["existing"]);
    expect(story.repoScopedFixes?.[1]?.triggeringTests).toEqual(["new"]);
  });

  test("AC-11: does not create an empty array when records is empty", () => {
    const story = makePersistedStory();

    repoScopedFixRecorder()(story, []);
    expect(story.repoScopedFixes).toBeUndefined();
  });

  test("AC-12: does not change a story when records is undefined", () => {
    const story = makePersistedStory();

    repoScopedFixRecorder()(story, undefined);
    expect(story.repoScopedFixes).toBeUndefined();
  });

  test("AC-13: records synchronously and returns undefined", () => {
    const story = makePersistedStory();
    const result = repoScopedFixRecorder()(story, repoScopedFixes(["sync"], ["sync.ts"], true));

    expect(result).toBeUndefined();
    expect(Object.prototype.toString.call(result)).toBe("[object Undefined]");
  });

  test("AC-14: exports recordRepoScopedFixes from the execution barrel", () => {
    expect(typeof recordRepoScopedFixes).toBe("function");
  });

  test("AC-15: execution records the plan's exact repo-scoped-fixes array", async () => {
    const ctx = makeExecutionContext();
    const records = repoScopedFixes(["t"], ["f"], 1);
    const deps = _executionDeps as unknown as ExecutionDepsWithRecorder;
    const recorderSpy = mock((_story: PersistedStory, _records?: readonly PersistedRepoScopedFix[]) => undefined);
    deps.recordRepoScopedFixes = recorderSpy;
    _executionDeps.buildPlanForStrategy = async () => ({ run: async () => makePlanResult(records) }) as never;

    await executionStage.execute(ctx);
    expect(recorderSpy).toHaveBeenCalledTimes(1);
    expect(recorderSpy.mock.calls[0]?.[0]).toBe(ctx.story);
    expect(recorderSpy.mock.calls[0]?.[1]).toBe(records);
  });

  test("AC-16: execution records fixes before post-run inspection", async () => {
    const ctx = makeExecutionContext();
    const calls: string[] = [];
    const deps = _executionDeps as unknown as ExecutionDepsWithRecorder;
    const recorderSpy = mock(() => { calls.push("recordRepoScopedFixes"); return undefined; });
    const inspectionSpy = mock(async () => { calls.push("applyPostRunInspection"); return {}; });
    deps.recordRepoScopedFixes = recorderSpy;
    _executionDeps.applyPostRunInspection = inspectionSpy as typeof _executionDeps.applyPostRunInspection;
    _executionDeps.buildPlanForStrategy = async () => ({ run: async () => makePlanResult(repoScopedFixes(["t"], ["f"], 1)) }) as never;

    await executionStage.execute(ctx);
    expect(recorderSpy).toHaveBeenCalled();
    expect(inspectionSpy).toHaveBeenCalled();
    expect(calls.indexOf("recordRepoScopedFixes")).toBeLessThan(calls.indexOf("applyPostRunInspection"));
  });

  test("AC-17: execution leaves repoScopedFixes undefined when the plan has none", async () => {
    const story = makePersistedStory({ status: "in-progress" });
    const ctx = makeExecutionContext(story);
    _executionDeps.buildPlanForStrategy = async () => ({ run: async () => makePlanResult() }) as never;

    await executionStage.execute(ctx);
    expect(story.repoScopedFixes).toBeUndefined();
  });

  test("AC-18: execution persists plan fixes even when the plan reports failure", async () => {
    const story = makePersistedStory({ status: "in-progress" });
    const ctx = makeExecutionContext(story);
    const records = repoScopedFixes(["failed"], ["failure.ts"], false);
    _executionDeps.buildPlanForStrategy = async () => ({ run: async () => makePlanResult(records, false) }) as never;

    await executionStage.execute(ctx);
    expect(story.repoScopedFixes).toHaveLength(1);
  });

  test("AC-19: execution propagates a plan.run rejection", async () => {
    const ctx = makeExecutionContext();
    _executionDeps.buildPlanForStrategy = async () => ({ run: async () => { throw new Error("test-error"); } }) as never;

    let caught: unknown;
    try {
      await executionStage.execute(ctx);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe("test-error");
  });

  test("AC-20: execution does not persist fixes after a plan.run rejection", async () => {
    const story = makePersistedStory({ status: "in-progress" });
    const ctx = makeExecutionContext(story);
    _executionDeps.buildPlanForStrategy = async () => ({ run: async () => { throw new Error("plan failed"); } }) as never;

    await executionStage.execute(ctx).catch(() => {});
    expect(story.repoScopedFixes).toBeUndefined();
  });
});