/**
 * `handlePipelineFailure` — PRD progress commits (#2533).
 *
 * The result handler is one of the three writers of a story's status, and the
 * only one that runs *after* something went wrong: a story that pauses or
 * fails is exactly when the PRD has to be committed, because the next attempt
 * starts from the tree.
 *
 * Describe-block split of `pipeline-result-handler.test.ts` (752 lines, past
 * the 650 split target): the handler's own behaviour lives there, the seam its
 * status writes commit through lives here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeAgentResult,
  makeDispatchContext,
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
  type PipelineHandlerContext,
} from "@/execution/pipeline-result-handler";
import type { PipelineRunResult } from "@/pipeline/runner";
import { PluginRegistry } from "@/plugins/registry";
import type { PRD, UserStory } from "@/prd/types";

type ProgressCall = [prd: PRD, prdPath: string, storyId: string, label: string];

const ORIG_SAVE_PRD_PROGRESS = _resultHandlerDeps.savePrdProgress;
const ORIG_SPAWN = _resultHandlerDeps.spawn;

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
