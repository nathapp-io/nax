/**
 * #2554 item 10: a dependency-prep failure marks the story failed, and that
 * status write must be committed (savePrdProgress), not left as a dirty prd.json.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  makeWorktreeManager,
} from "@test/helpers";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import { _iterationRunnerDeps, runIteration } from "@/execution/iteration-runner";
import type { RoutingResult } from "@/pipeline/types";

const ROUTING: RoutingResult = {
  complexity: "simple",
  modelTier: "fast",
  testStrategy: "test-after",
  reasoning: "test",
};

describe("runIteration - dependency-prep failure commits the PRD (#2554)", () => {
  let tempDir: string;
  const orig = { ..._iterationRunnerDeps };

  beforeEach(() => {
    tempDir = makeTempDir("nax-iteration-depprep-");
  });

  afterEach(() => {
    Object.assign(_iterationRunnerDeps, orig);
    cleanupTempDir(tempDir);
  });

  test("saves the failed story through savePrdProgress", async () => {
    const calls: Array<{ path: string; storyId: string; label: string; status: string | undefined }> = [];
    _iterationRunnerDeps.savePrdProgress = async (prd, path, storyId, label) => {
      calls.push({ path, storyId, label, status: prd.userStories.find((s) => s.id === storyId)?.status });
    };
    _iterationRunnerDeps.existsSync = () => true;
    _iterationRunnerDeps.worktreeManager = makeWorktreeManager();
    _iterationRunnerDeps.prepareWorktreeDependencies = async () => {
      throw new Error("deps boom");
    };

    const story = makeStory({ id: "US-001" });
    const prd = makePRD({ userStories: [story] });
    const ctx: SequentialExecutionContext = {
      prdPath: join(tempDir, "prd.json"),
      workdir: tempDir,
      config: makeNaxConfig({ execution: { storyIsolation: "worktree" } }),
      hooks: { hooks: {} },
      feature: "f",
      dryRun: false,
      useBatch: false,
      pluginRegistry: makePluginRegistry(),
      statusWriter: makeStatusWriter(),
      runId: "run-test",
      startTime: Date.now(),
      batchPlan: [],
      interactionChain: null,
      ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: tempDir }) }),
    };

    await runIteration(
      ctx,
      prd,
      { story, storiesToExecute: [story], routing: ROUTING, isBatchExecution: false },
      1,
      0,
      [],
    );

    expect(calls).toEqual([{ path: join(tempDir, "prd.json"), storyId: "US-001", label: "failed", status: "failed" }]);
  });
});
