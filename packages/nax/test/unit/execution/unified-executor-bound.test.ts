import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTempDir,
  withWarnSpy,
} from "@test/helpers";
import { stopHeartbeat } from "@/execution/crash-recovery";
import type { StorySelection } from "@/execution/story-selector";
import { _unifiedExecutorDeps, executeUnified, type SequentialExecutionContext } from "@/execution/unified-executor";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD } from "@/prd/types";

const original = { ..._unifiedExecutorDeps };
let dir: string;
beforeEach(() => {
  dir = makeTempDir("nax-loop-bound-");
  _unifiedExecutorDeps.runWorkflowPreflight = async () => {};
});
afterEach(() => {
  Object.assign(_unifiedExecutorDeps, original);
  stopHeartbeat();
  pipelineEventBus.clear();
  cleanupTempDir(dir);
});
function ctx(maxIterations: number): SequentialExecutionContext {
  return {
    ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: dir }) }),
    config: makeNaxConfig({
      execution: { mode: "pipeline", maxIterations, iterationDelayMs: 0 },
      acceptance: { enabled: false },
      autoMode: { escalation: { enabled: false } },
    }),
    prdPath: `${dir}/prd.json`,
    workdir: dir,
    feature: "f",
    hooks: { hooks: {} },
    dryRun: false,
    useBatch: false,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    runId: "bound",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
  };
}
describe("executeUnified derived bound", () => {
  test("pipeline literal ignores maxIterations 1 and completes three pending stories", async () => {
    const prd = makePRD({
      userStories: [1, 2, 3].map((n) => makeStory({ id: `US-${n}`, status: "pending", passes: false })),
    });
    _unifiedExecutorDeps.runIteration = mock(
      async (_ctx: SequentialExecutionContext, current: PRD, selection: StorySelection) => ({
        prd: {
          ...current,
          userStories: current.userStories.map((s) =>
            s.id === selection.story.id ? { ...s, status: "passed" as const, passes: true } : s,
          ),
        },
        storiesCompletedDelta: 1,
        costDelta: 0,
        prdDirty: false,
      }),
    );
    const result = await executeUnified(ctx(1), prd);
    expect(result.storiesCompleted).toBe(3);
    expect(result.exitReason).toBe("completed");
    expect(result.prd.userStories.every((s) => s.passes)).toBe(true);
    expect(_unifiedExecutorDeps.runIteration).toHaveBeenCalledTimes(3);
  });
  test("pipeline literal stalls after one unchanged iteration and warns about the derived bound", async () => {
    const prd = makePRD({ userStories: [makeStory({ status: "pending", passes: false })] });
    _unifiedExecutorDeps.runIteration = mock(async (_ctx: SequentialExecutionContext, current: PRD) => ({
      prd: current,
      storiesCompletedDelta: 0,
      costDelta: 0,
      prdDirty: false,
    }));
    await withWarnSpy(async (warn) => {
      const result = await executeUnified(ctx(7), prd);
      expect(result.exitReason).toBe("max-iterations");
      expect(warn).toHaveBeenCalledWith(
        "execution",
        expect.stringMatching(/^Exit reason max-iterations: the derived loop bound \(/),
        expect.objectContaining({ storyId: "_run", exitReason: "max-iterations" }),
      );
      expect(_unifiedExecutorDeps.runIteration).toHaveBeenCalledTimes(1);
    });
  });
  test("pipeline literal completes when the final derived-bound iteration settles the last story", async () => {
    // A failed story has no pending-work allowance and no lastStoryId retry yet: bound = 1.
    // Direct parallel dispatch supplies that story; completion must be detected after loop exit.
    const story = makeStory({ status: "failed", passes: false, attempts: 0 });
    const prd = makePRD({ userStories: [story] });
    _unifiedExecutorDeps.selectIndependentBatch = () => [story];
    _unifiedExecutorDeps.runIteration = mock(async () => ({
      prd: { ...prd, userStories: [{ ...story, status: "passed" as const, passes: true }] },
      storiesCompletedDelta: 1,
      costDelta: 0,
      prdDirty: false,
    }));
    const result = await executeUnified({ ...ctx(1), parallelCount: 2 }, prd);
    expect(result.iterations).toBe(1);
    expect(result.exitReason).toBe("completed");
    expect(result.storiesCompleted).toBe(1);
  });
});
