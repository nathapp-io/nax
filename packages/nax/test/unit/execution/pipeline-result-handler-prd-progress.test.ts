/**
 * `handlePipelineFailure` / `handlePipelineSuccess` — PRD progress commits (#2533).
 *
 * The result handler is one of the three writers of a story's status, and the
 * only one that runs *after* something went wrong: a story that pauses, fails,
 * or passes its pipeline but never lands on the base branch is exactly when the
 * PRD has to be committed, because the next attempt starts from the tree.
 *
 * Describe-block split of `pipeline-result-handler.test.ts` (752 lines, past
 * the 650 split target): the handler's own behaviour lives there, the seam its
 * status writes commit through lives here.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeAgentResult,
  makeDispatchContext,
  makeMergeEngine,
  makePRD,
  makeSpawn,
  makeStory,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import {
  _resultHandlerDeps,
  handlePipelineFailure,
  handlePipelineSuccess,
  type PipelineHandlerContext,
} from "@/execution/pipeline-result-handler";
import type { PipelineRunResult } from "@/pipeline/runner";
import { PluginRegistry } from "@/plugins/registry";
import type { PRD, UserStory } from "@/prd/types";

type ProgressCall = [prd: PRD, prdPath: string, storyId: string, label: string];

const ORIG_SAVE_PRD_PROGRESS = _resultHandlerDeps.savePrdProgress;
const ORIG_MERGE_ENGINE = _resultHandlerDeps.mergeEngine;
const ORIG_SPAWN = _resultHandlerDeps.spawn;

const WORKTREE_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, storyIsolation: "worktree" as const },
};

let workdir: string;

/** Capture every `savePrdProgress` the handler makes, without touching disk or git. */
function captureProgressCalls(): ProgressCall[] {
  const calls: ProgressCall[] = [];
  _resultHandlerDeps.savePrdProgress = async (prd, prdPath, storyId, label) => {
    calls.push([prd, prdPath, storyId, label]);
  };
  return calls;
}

function makeCtx(story: UserStory, overrides: Partial<PipelineHandlerContext> = {}): PipelineHandlerContext {
  return {
    config: DEFAULT_CONFIG,
    prd: makePRD({ feature: "test-feature", userStories: [story] }),
    prdPath: join(workdir, "prd.json"),
    workdir,
    hooks: { hooks: {} },
    feature: "test-feature",
    totalCost: 0,
    startTime: Date.now(),
    runId: "run-001",
    pluginRegistry: new PluginRegistry([]),
    story,
    storiesToExecute: [story],
    routing: { complexity: "simple", modelTier: "standard", testStrategy: "test-after", reasoning: "" },
    isBatchExecution: false,
    allStoryMetrics: [],
    storyGitRef: undefined,
    ...makeDispatchContext(),
    ...overrides,
  };
}

function result(finalAction: PipelineRunResult["finalAction"], reason?: string): PipelineRunResult {
  return {
    success: false,
    finalAction,
    ...(reason === undefined ? {} : { reason }),
    context: makeTestContext({ agentResult: makeAgentResult() }),
  };
}

beforeEach(() => {
  workdir = makeTempDir("nax-result-handler-progress-");
  // Nothing spawns git from these fixtures: the worktree-cleanup path keys off
  // real existence and `<workdir>/.nax-wt/<id>` does not exist, and the git
  // stub keeps any other call deterministic.
  _resultHandlerDeps.spawn = makeSpawn(() => "").spawn;
});

afterEach(() => {
  _resultHandlerDeps.savePrdProgress = ORIG_SAVE_PRD_PROGRESS;
  _resultHandlerDeps.mergeEngine = ORIG_MERGE_ENGINE;
  _resultHandlerDeps.spawn = ORIG_SPAWN;
  cleanupTempDir(workdir);
});

describe("handlePipelineFailure — PRD progress commits", () => {
  test("a failed story commits its 'failed' status", async () => {
    const ctx = makeCtx(makeStory({ id: "US-001", status: "in-progress", passes: false, attempts: 1 }));
    const calls = captureProgressCalls();

    await handlePipelineFailure(ctx, result("fail", "Tests failed"));

    expect(calls.map(([, , storyId, label]) => [storyId, label])).toEqual([["US-001", "failed"]]);
    expect(calls[0]?.[0]).toBe(ctx.prd);
    expect(calls[0]?.[1]).toBe(ctx.prdPath);
  });

  test("a paused story commits its 'paused' status", async () => {
    const ctx = makeCtx(makeStory({ id: "US-001", status: "in-progress", passes: false, attempts: 1 }));
    const calls = captureProgressCalls();

    await handlePipelineFailure(ctx, result("pause"));

    expect(calls.map(([, , storyId, label]) => [storyId, label])).toEqual([["US-001", "paused"]]);
  });

  test("a skipped story commits nothing — its status never changed", async () => {
    const ctx = makeCtx(makeStory({ id: "US-001", status: "in-progress", passes: false, attempts: 1 }));
    const calls = captureProgressCalls();

    await handlePipelineFailure(ctx, result("skip", "Dependency not met"));

    expect(calls).toEqual([]);
  });
});

describe("handlePipelineSuccess — PRD progress commits", () => {
  test("a story whose branch never landed commits its 'failed' status", async () => {
    // The merge failed for a non-conflict reason, so the handler corrects the
    // status completionStage already wrote ("passed") back to "failed". That
    // correction is worthless unless it sticks on disk — which is what the
    // PRD commit is for.
    const story = makeStory({ id: "US-001", status: "passed", passes: true, attempts: 1 });
    const ctx = makeCtx(story, { config: WORKTREE_CONFIG });
    _resultHandlerDeps.mergeEngine = makeMergeEngine({
      merge: mock(async () => ({ success: false, failureKind: "error", error: "dirty tree" })),
    });
    const calls = captureProgressCalls();

    const outcome = await handlePipelineSuccess(ctx, {
      success: true,
      finalAction: "complete",
      context: makeTestContext({ agentResult: makeAgentResult(), storyMetrics: [] }),
    });

    expect(outcome.storiesCompletedDelta).toBe(0);
    expect(calls.map(([, , storyId, label]) => [storyId, label])).toEqual([["US-001", "failed"]]);
  });

  test("a story that landed commits nothing — completionStage already did", async () => {
    // The single writer rule: the completion stage commits the "passed" status
    // on the success path, so a second commit here would be an empty one.
    const story = makeStory({ id: "US-001", status: "passed", passes: true, attempts: 1 });
    const ctx = makeCtx(story, { config: WORKTREE_CONFIG });
    _resultHandlerDeps.mergeEngine = makeMergeEngine({ merge: mock(async () => ({ success: true })) });
    const calls = captureProgressCalls();

    await handlePipelineSuccess(ctx, {
      success: true,
      finalAction: "complete",
      context: makeTestContext({ agentResult: makeAgentResult(), storyMetrics: [] }),
    });

    expect(calls).toEqual([]);
  });
});
