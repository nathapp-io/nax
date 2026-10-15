import { afterEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
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
} from "@test/helpers";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import { type ParallelDispatchDeps, runParallelDispatch } from "@/execution/unified-executor-parallel-dispatch";
import { buildNaxIgnoreIndex } from "@/utils/path-filters";

let runtime: ReturnType<typeof makeMockRuntime> | undefined;
let dir: string | undefined;
afterEach(async () => {
  await runtime?.close();
  if (dir) cleanupTempDir(dir);
  mock.restore();
});

test("AC-11 many-story dispatch forwards parallel metadata and copies active list", async () => {
  dir = makeTempDir("dispatch-active-");
  runtime = makeMockRuntime({ workdir: dir });
  const stories = [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })];
  const prd = makePRD({ userStories: stories });
  const setParallel = mock<SequentialExecutionContext["statusWriter"]["setParallel"]>(() => {});
  const ctx: SequentialExecutionContext = {
    prdPath: join(dir, "prd.json"),
    workdir: dir,
    config: makeNaxConfig({ execution: { iterationDelayMs: 0 } }),
    hooks: { hooks: {} },
    feature: "test",
    dryRun: false,
    useBatch: false,
    parallelCount: 2,
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter({ setParallel }),
    runId: "test",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    ...makeDispatchContext({ runtime }),
  };
  const active = [{ storyId: "US-001", worktreePath: "/w/.nax-wt/a" }];
  const deps: ParallelDispatchDeps = {
    selectIndependentBatch: () => stories,
    preIterationTierCheck: async () => ({ shouldSkipIteration: false, prd, prdDirty: false }),
    runIteration: mock(async () => {
      throw new Error("unexpected sequential dispatch");
    }),
    runParallelBatch: mock(async ({ ctx: batchCtx }) => {
      batchCtx.onActiveStories?.(active);
      expect(setParallel).toHaveBeenCalledWith({ enabled: true, maxConcurrency: 2, activeStories: active });
      active.length = 0;
      expect(setParallel.mock.calls[0]?.[0].activeStories).toHaveLength(1);
      return { completed: [], failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 };
    }),
  };
  await runParallelDispatch(
    {
      ctx,
      state: { prd, prdDirty: false, totalCost: 0, storiesCompleted: 0, lastStoryId: null, warningSent: false },
      iterations: 1,
      allStoryMetrics: [],
      naxIgnoreIndex: await buildNaxIgnoreIndex(dir),
      costLimit: Number.POSITIVE_INFINITY,
      reportCost: () => {},
    },
    deps,
  );
  expect(deps.runParallelBatch).toHaveBeenCalledTimes(1);
  expect(deps.runIteration).not.toHaveBeenCalled();
});
