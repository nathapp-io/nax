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
describe("executeUnified — an already-passed PRD completes without an iteration", () => {
  function allPassedPrd(): PRD {
    return makePRD({
      userStories: [
        makeStory({ id: "US-1", status: "passed", passes: true }),
        makeStory({ id: "US-2", status: "passed", passes: true }),
      ],
    });
  }

  test("US-007 AC-1: returns exit reason completed", async () => {
    const result = await executeUnified(ctx(3), allPassedPrd());
    expect(result.exitReason).toBe("completed");
    expect(result.prd.userStories.every((s) => s.passes)).toBe(true);
  });

  test("US-007 AC-2: never calls the stubbed runIteration", async () => {
    const runIteration = mock(async () => {
      throw new Error("runIteration must not run for an already-passed PRD");
    });
    _unifiedExecutorDeps.runIteration = runIteration;
    const result = await executeUnified(ctx(3), allPassedPrd());
    expect(result.exitReason).toBe("completed");
    expect(runIteration).not.toHaveBeenCalled();
  });

  test("US-007 AC-2: a workflow-mode run reaches the same completion without an iteration", async () => {
    const runIteration = mock(async () => {
      throw new Error("runIteration must not run for an already-passed PRD");
    });
    _unifiedExecutorDeps.runIteration = runIteration;
    const workflowCtx = {
      ...ctx(3),
      config: makeNaxConfig({
        execution: { mode: "workflow", maxIterations: 3, iterationDelayMs: 0 },
        acceptance: { enabled: false },
        autoMode: { escalation: { enabled: false } },
      }),
    };
    const result = await executeUnified(workflowCtx, allPassedPrd());
    expect(result.exitReason).toBe("completed");
    expect(runIteration).not.toHaveBeenCalled();
  });
});

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
});
