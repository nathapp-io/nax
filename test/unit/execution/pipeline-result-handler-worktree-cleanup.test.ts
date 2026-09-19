/**
 * Unit tests for pipeline-result-handler.ts — worktree cleanup (EXEC-002 / MEM-6)
 *
 * Split out of pipeline-result-handler.test.ts to stay under the 800-line test
 * file cap (.claude/rules/project-conventions.md).
 *
 * MEM-6: cleanup now keys off real worktree *existence* (checked via
 * `_resultHandlerDeps.existsSync`) rather than `storyIsolation` config mode —
 * parallel-batch dispatch creates a worktree per story unconditionally, so
 * the config-gated check used to leak worktrees for shared-mode failures.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeAgentResult,
  makeMockRuntime,
  makePRD,
  makeSpawn,
  makeStory,
  makeTestContext,
  withWarnSpy,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import {
  _resultHandlerDeps,
  handlePipelineFailure,
  type PipelineHandlerContext,
} from "@/execution/pipeline-result-handler";
import type { PipelineRunResult } from "@/pipeline/runner";
import { PluginRegistry } from "@/plugins/registry";
import type { UserStory } from "@/prd/types";

function makeCtx(story: UserStory, overrides: Partial<PipelineHandlerContext> = {}): PipelineHandlerContext {
  const prd = makePRD({ userStories: [story] });
  return {
    config: DEFAULT_CONFIG,
    prd,
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/repo",
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
    storyGitRef: "abc123",
    runtime: makeMockRuntime(),
    ...overrides,
  } as PipelineHandlerContext;
}

function mockSpawnCapturingCalls(calls: string[][]) {
  return makeSpawn((call) => {
    calls.push(call.cmd);
    return {};
  }).spawn;
}

const WORKTREE_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, storyIsolation: "worktree" as const },
};

let origResultSpawn: typeof _resultHandlerDeps.spawn;
let origExistsSync: typeof _resultHandlerDeps.existsSync;

beforeEach(() => {
  origResultSpawn = _resultHandlerDeps.spawn;
  origExistsSync = _resultHandlerDeps.existsSync;
  // Default to "does not exist" — the safe, deterministic default. Tests
  // that specifically exercise worktree removal opt in explicitly.
  _resultHandlerDeps.existsSync = (() => false) as typeof _resultHandlerDeps.existsSync;
});

afterEach(() => {
  _resultHandlerDeps.spawn = origResultSpawn;
  _resultHandlerDeps.existsSync = origExistsSync;
  mock.restore();
});

describe("handlePipelineFailure — worktree mode (EXEC-002)", () => {
  test("calls git worktree remove on 'fail' finalAction in worktree mode", async () => {
    const story = makeStory({ id: "US-001", status: "pending", passes: false, attempts: 2 });
    const ctx = makeCtx(story, {
      config: {
        ...WORKTREE_CONFIG,
        execution: {
          ...WORKTREE_CONFIG.execution,
          rectification: { ...WORKTREE_CONFIG.execution.rectification, maxAttemptsTotal: 1 },
        },
      },
    });
    _resultHandlerDeps.existsSync = (() => true) as typeof _resultHandlerDeps.existsSync;

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = mockSpawnCapturingCalls(spawnCalls);

    const failResult: PipelineRunResult = {
      success: false,
      finalAction: "fail",
      reason: "Tests failed",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, failResult);

    const worktreeRemoveCalls = spawnCalls.filter((a) => a.includes("worktree") && a.includes("remove"));
    expect(worktreeRemoveCalls.length).toBeGreaterThan(0);
    // Branch NOT deleted (only directory removed)
    const branchDeleteCalls = spawnCalls.filter((a) => a.includes("branch") && a.includes("-D"));
    expect(branchDeleteCalls.length).toBe(0);
  });

  test("does NOT call git worktree remove in shared mode on 'fail'", async () => {
    const story = makeStory({ id: "US-001", status: "pending", passes: false, attempts: 2 });
    const ctx = makeCtx(story);

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = mockSpawnCapturingCalls(spawnCalls);

    const failResult: PipelineRunResult = {
      success: false,
      finalAction: "fail",
      reason: "Tests failed",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, failResult);

    const worktreeRemoveCalls = spawnCalls.filter((a) => a.includes("worktree") && a.includes("remove"));
    expect(worktreeRemoveCalls.length).toBe(0);
  });

  test("calls git worktree remove on 'pause' finalAction when a worktree exists", async () => {
    const story = makeStory({ id: "US-001", status: "in-progress" });
    const ctx = makeCtx(story, { config: WORKTREE_CONFIG });
    _resultHandlerDeps.existsSync = (() => true) as typeof _resultHandlerDeps.existsSync;

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = mockSpawnCapturingCalls(spawnCalls);

    const pauseResult: PipelineRunResult = {
      success: false,
      finalAction: "pause",
      reason: "Semantic review paused",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, pauseResult);

    const worktreeRemoveCalls = spawnCalls.filter((a) => a.includes("worktree") && a.includes("remove"));
    expect(worktreeRemoveCalls.length).toBeGreaterThan(0);
  });

  test("does NOT call git worktree remove on 'pause' finalAction when no worktree exists", async () => {
    const story = makeStory({ id: "US-001", status: "in-progress" });
    const ctx = makeCtx(story);

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = mockSpawnCapturingCalls(spawnCalls);

    const pauseResult: PipelineRunResult = {
      success: false,
      finalAction: "pause",
      reason: "Semantic review paused",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, pauseResult);

    const worktreeRemoveCalls = spawnCalls.filter((a) => a.includes("worktree") && a.includes("remove"));
    expect(worktreeRemoveCalls.length).toBe(0);
  });

  // Adversarial finding (US-002): the pause path reaches removeWorktreeDirectory,
  // which writes the orphan ref UNCONDITIONALLY. When a paused story is later
  // resumed, iteration-runner.ts calls create(), whose Step 3 force-deletes
  // `nax/<storyId>` on the orphan-ref evidence — silently discarding the WIP
  // branch the pause path documented as preserved. Gate the orphan ref on a
  // successful `git worktree remove` so only the fail path writes it.
  test("does NOT call git update-ref on 'pause' finalAction (orphan ref is a fail-path artifact only)", async () => {
    const story = makeStory({ id: "US-001", status: "in-progress" });
    const ctx = makeCtx(story, { config: WORKTREE_CONFIG });
    _resultHandlerDeps.existsSync = (() => true) as typeof _resultHandlerDeps.existsSync;

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = mockSpawnCapturingCalls(spawnCalls);

    const pauseResult: PipelineRunResult = {
      success: false,
      finalAction: "pause",
      reason: "Semantic review paused",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, pauseResult);

    // Even when a worktree exists and removeWorktreeDirectory is called on
    // pause, no orphan-ref update-ref should fire — the ref is scoped to
    // the fail path per AC-1/AC-4/AC-5/AC-6.
    const updateRefCalls = spawnCalls.filter((a) => a[0] === "git" && a[1] === "update-ref");
    expect(updateRefCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// US-002 — handlePipelineFailure records nax ownership of the surviving
// `nax/<storyId>` branch when the worktree directory is removed. The ref name
// is built once by `naxOrphanRefName` (see test/unit/worktree/nax-orphan-ref.test.ts).
// AC-6: when the ownership-record `git update-ref` fails, the handler must
// return without throwing and emit a warn log on stage `worktree` carrying
// the story id.
// ---------------------------------------------------------------------------

describe("US-002 handlePipelineFailure — record nax ownership of orphan branch", () => {
  test("AC-6: when the ownership-record git call fails, handlePipelineFailure returns and logs a warn on stage 'worktree' carrying story id 'US-001'", async () => {
    const story = makeStory({
      id: "US-001",
      status: "pending",
      passes: false,
      attempts: 2,
    });
    const ctx = makeCtx(story, {
      config: {
        ...WORKTREE_CONFIG,
        execution: {
          ...WORKTREE_CONFIG.execution,
          rectification: { ...WORKTREE_CONFIG.execution.rectification, maxAttemptsTotal: 1 },
        },
      },
    });
    _resultHandlerDeps.existsSync = (() => true) as typeof _resultHandlerDeps.existsSync;

    // The ownership-record `git update-ref` call is the one that fails.
    // All other spawns succeed (worktree remove, etc).
    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = makeSpawn((call) => {
      spawnCalls.push(call.cmd);
      if (call.cmd[0] === "git" && call.cmd[1] === "update-ref") {
        return { exitCode: 1, stdout: "", stderr: "fatal: could not lock ref" };
      }
      return {};
    }).spawn;

    await withWarnSpy(async (warnSpy) => {
      // Must NOT throw — best-effort per the spec.
      await expect(handlePipelineFailure(ctx, failResultFor("US-001"))).resolves.toBeDefined();

      // The warn log must carry stage 'worktree' and story id 'US-001'.
      const ownershipRecordWarn = warnSpy.mock.calls.find((c) => {
        if (c[0] !== "worktree") return false;
        const data = JSON.stringify(c[2] ?? {});
        return data.includes("US-001") && /update-ref|ownership|orphan/i.test(data);
      });
      expect(ownershipRecordWarn).toBeDefined();
    });

    // Verify the ownership-record git call was attempted.
    const updateRefCalls = spawnCalls.filter((a) => a[0] === "git" && a[1] === "update-ref");
    expect(updateRefCalls.length).toBeGreaterThan(0);
  });

  // Adversarial finding (US-002): the orphan ref is written UNCONDITIONALLY
  // after `git worktree remove`, even when git reported a non-zero exit. In
  // that case the branch is still checked out in a (surviving) live worktree,
  // so claiming nax ownership of an "orphan" is a false record. Gate the
  // orphan ref on exitCode === 0.
  test("does NOT call git update-ref when git worktree remove itself failed", async () => {
    const story = makeStory({
      id: "US-001",
      status: "pending",
      passes: false,
      attempts: 2,
    });
    const ctx = makeCtx(story, {
      config: {
        ...WORKTREE_CONFIG,
        execution: {
          ...WORKTREE_CONFIG.execution,
          rectification: { ...WORKTREE_CONFIG.execution.rectification, maxAttemptsTotal: 1 },
        },
      },
    });
    _resultHandlerDeps.existsSync = (() => true) as typeof _resultHandlerDeps.existsSync;

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = makeSpawn(({ cmd }) => {
      spawnCalls.push(cmd);
      // `git worktree remove` fails (e.g. NFS hang, locked ref) — the
      // worktree directory and branch are both still in place.
      if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "remove") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "fatal: could not lock ref",
        };
      }
      return {};
    }).spawn;

    const failResult: PipelineRunResult = {
      success: false,
      finalAction: "fail",
      reason: "Tests failed",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, failResult);

    // The orphan ref must NOT be written when worktree remove failed —
    // claiming nax owns an orphan when the branch is still in a live
    // worktree is a false record that would mislead the next create().
    const updateRefCalls = spawnCalls.filter((a) => a[0] === "git" && a[1] === "update-ref");
    expect(updateRefCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// US-002 — AC-4: the surviving branch is preserved for diagnostics.
//
// Given `.nax-wt/US-001` exists and handlePipelineFailure has run with
// finalAction 'fail' and tiers exhausted, the `nax/US-001` branch must
// still resolve to a commit — verified end-to-end by the integration test
// (AC-1) which observes a real git repo. The unit-level guarantee that
// `removeWorktreeDirectory` itself never deletes the branch is asserted
// below: when no live worktree exists to remove, removeWorktreeDirectory
// makes zero git calls (it short-circuits via hasWorktree), and the
// `fail` branch never invokes `git branch -D` for the story's branch.
// ---------------------------------------------------------------------------

describe("US-002 handlePipelineFailure — preserves the surviving branch", () => {
  test("AC-4 (unit): handlePipelineFailure never invokes git branch -D in the fail+worktree path", async () => {
    const story = makeStory({
      id: "US-001",
      status: "pending",
      passes: false,
      attempts: 2,
    });
    const ctx = makeCtx(story, {
      config: {
        ...WORKTREE_CONFIG,
        execution: {
          ...WORKTREE_CONFIG.execution,
          rectification: { ...WORKTREE_CONFIG.execution.rectification, maxAttemptsTotal: 1 },
        },
      },
    });
    // hasWorktree() returns true so removeWorktreeDirectory runs, but the
    // mocked spawn for `git worktree remove` returns WORKTREE_NOT_FOUND
    // ("is not a working tree"), so remove() short-circuits — its
    // internal `branch -D` is never reached. The branch must survive.
    _resultHandlerDeps.existsSync = (() => true) as typeof _resultHandlerDeps.existsSync;

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = makeSpawn(({ cmd }) => {
      spawnCalls.push(cmd);
      if (cmd[0] === "git" && cmd[1] === "worktree" && cmd[2] === "remove") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "fatal: '.nax-wt/US-001' is not a working tree",
        };
      }
      return {};
    }).spawn;

    const failResult: PipelineRunResult = {
      success: false,
      finalAction: "fail",
      reason: "Tests failed",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    };

    await handlePipelineFailure(ctx, failResult);

    // With no live worktree to remove, neither removeWorktreeDirectory
    // nor remove() invokes `git branch -D`. The branch survives.
    const branchDeleteCalls = spawnCalls.filter((a) => a[0] === "git" && a[1] === "branch" && a[2] === "-D");
    expect(branchDeleteCalls.length).toBe(0);
  });
});

function failResultFor(_storyId: string): PipelineRunResult {
  return {
    success: false,
    finalAction: "fail",
    reason: "Tests failed",
    context: makeTestContext({ agentResult: makeAgentResult() }),
  };
}
