/**
 * Unit tests for pipeline-result-handler.ts — a worktree merge conflict is a
 * failed story, not a rectification pass (US-001).
 *
 * Split out of pipeline-result-handler.test.ts to stay under the 800-line test
 * file cap (.claude/rules/project-conventions.md).
 *
 * Before this story a conflict re-ran the story through a rectification pass
 * and only failed when the re-run also failed. That module is gone: a conflict
 * now fails the story immediately, with a reason naming the conflicted files,
 * and the worktree is kept for inspection exactly as the unrectified path kept
 * it.
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
  handlePipelineSuccess,
  type PipelineHandlerContext,
} from "@/execution/pipeline-result-handler";
import { pipelineEventBus, type StoryFailedEvent } from "@/pipeline/event-bus";
import type { PipelineRunResult } from "@/pipeline/runner";
import { PluginRegistry } from "@/plugins/registry";
import { loadPRD, savePRD } from "@/prd";

const WORKTREE_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, storyIsolation: "worktree" as const },
};

/** The state completionStage leaves behind: passed, with one attempt spent. */
function makePassedStory(id: string) {
  return makeStory({ id, title: `Story ${id}`, description: "", status: "passed", passes: true, attempts: 1 });
}

function makeMinimalResult(): PipelineRunResult {
  return {
    success: true,
    finalAction: "complete",
    context: makeTestContext({ agentResult: makeAgentResult(), storyMetrics: [] }),
  };
}

// A real dir under `$TMPDIR`: the handler persists the PRD there, and a
// confined run may not write a literal `/tmp/...`.
let workdir: string;
let prdPath: string;

let origSpawn: typeof _resultHandlerDeps.spawn;
let origMergeEngine: typeof _resultHandlerDeps.mergeEngine;
let origExistsSync: typeof _resultHandlerDeps.existsSync;

beforeEach(() => {
  workdir = makeTempDir("nax-merge-conflict-");
  prdPath = join(workdir, "prd.json");
  origSpawn = _resultHandlerDeps.spawn;
  origMergeEngine = _resultHandlerDeps.mergeEngine;
  origExistsSync = _resultHandlerDeps.existsSync;
  pipelineEventBus.clear();
});

afterEach(() => {
  _resultHandlerDeps.spawn = origSpawn;
  _resultHandlerDeps.mergeEngine = origMergeEngine;
  _resultHandlerDeps.existsSync = origExistsSync;
  pipelineEventBus.clear();
  cleanupTempDir(workdir);
  mock.restore();
});

/** Records every `_resultHandlerDeps.spawn` argv, so git calls stay observable. */
function recordSpawn(): string[][] {
  const calls: string[][] = [];
  _resultHandlerDeps.spawn = makeSpawn(({ cmd }) => {
    calls.push(cmd);
    return "";
  }).spawn;
  return calls;
}

function captureFailedEvents(): StoryFailedEvent[] {
  const seen: StoryFailedEvent[] = [];
  pipelineEventBus.on("story:failed", (event) => {
    seen.push(event as StoryFailedEvent);
  });
  return seen;
}

/**
 * Mirrors the state completionStage leaves behind — passed, in memory and on
 * disk — so the assertions read the correction back off the file.
 */
async function seedConflictCtx(conflictFiles: string[]): Promise<PipelineHandlerContext> {
  const story = makePassedStory("US-001");
  const ctx: PipelineHandlerContext = {
    config: WORKTREE_CONFIG,
    prd: makePRD({ feature: "test-feature", userStories: [story] }),
    prdPath,
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
  };
  _resultHandlerDeps.mergeEngine = makeMergeEngine({
    merge: mock(async () => ({ success: false as const, conflictFiles })),
  });
  await savePRD(ctx.prd, prdPath);
  return ctx;
}

describe("handlePipelineSuccess — a worktree merge conflict fails the story (US-001)", () => {
  // AC-5: the story is not counted as completed.
  test("AC-5: a conflict returns storiesCompletedDelta 0", async () => {
    const ctx = await seedConflictCtx(["foo.ts"]);
    recordSpawn();

    const result = await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(result.storiesCompletedDelta).toBe(0);
    expect(result.prdDirty).toBe(true);
  });

  // AC-6: the reason names the conflicted files and says the branch did not land.
  test("AC-6: a conflict emits exactly one story:failed naming the conflicted files", async () => {
    const ctx = await seedConflictCtx(["foo.ts"]);
    recordSpawn();
    const failed = captureFailedEvents();

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(failed).toHaveLength(1);
    expect(failed[0]?.storyId).toBe("US-001");
    expect(failed[0]?.reason).toBe("Merge conflict (foo.ts) — the branch did not land");
  });

  // AC-7: an empty conflict list falls back to the generic reason.
  test("AC-7: a conflict with no conflicted files uses the generic reason", async () => {
    const ctx = await seedConflictCtx([]);
    recordSpawn();
    const failed = captureFailedEvents();

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBe("Merge conflict — the branch did not land");
  });

  // AC-8: the correction survives a reload from disk.
  test("AC-8: a conflict persists the story's status as failed in prd.json", async () => {
    const ctx = await seedConflictCtx([]);
    recordSpawn();

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect((await loadPRD(prdPath)).userStories[0]?.status).toBe("failed");
  });

  // AC-10: no rectification pass is coming, so nothing reclaims the worktree —
  // it stays on disk for hand inspection. `existsSync` reports a live worktree
  // here, which is what would make the reclaim path fire if it were reached.
  test("AC-10: a conflict does not run git worktree remove", async () => {
    const ctx = await seedConflictCtx(["foo.ts"]);
    const calls = recordSpawn();
    _resultHandlerDeps.existsSync = (() => true) as typeof _resultHandlerDeps.existsSync;

    await handlePipelineSuccess(ctx, makeMinimalResult());

    const removes = calls.filter((cmd) => cmd[0] === "git" && cmd[1] === "worktree" && cmd.includes("remove"));
    expect(removes).toEqual([]);
  });
});
