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
import { makeAgentResult, makeMockRuntime, makePRD, makeStory, makeTestContext } from "@test/helpers";
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
    hooks: { hooks: [] } as unknown as PipelineHandlerContext["hooks"], // test-ratchet-allow: as-unknown-as
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
  return mock((args: unknown) => {
    calls.push(args as string[]);
    return {
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    };
  }) as unknown as typeof _resultHandlerDeps.spawn; // test-ratchet-allow: as-unknown-as
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
});
