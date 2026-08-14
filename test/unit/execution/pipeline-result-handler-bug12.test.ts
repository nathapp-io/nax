/**
 * BUG-12: worktree removal must drain stdout/stderr and surface non-zero exits
 *
 * removeWorktreeDirectory previously awaited `proc.exited` without consuming
 * stdout/stderr — a git error emitting >64KB fills the pipe buffer, the child
 * blocks writing, and the handler hangs. Non-zero exits were also invisible.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { makeMockRuntime, makeLogger, makePRD, makeStory } from "@test/helpers";
import * as loggerModule from "@/logger";
import type { UserStory } from "@/prd";
import {
  _resultHandlerDeps,
  handlePipelineFailure,
  type PipelineHandlerContext,
} from "@/execution";
import type { PipelineRunResult } from "@/pipeline";
import { PluginRegistry } from "@/plugins";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  } as unknown as PipelineHandlerContext; // test-ratchet-allow: as-unknown-as (agentManager/sessionManager are optional in tests)
}

const WORKTREE_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, storyIsolation: "worktree" as const },
};

const failResult: PipelineRunResult = {
  success: false,
  finalAction: "fail",
  reason: "Tests failed",
  context: { agentResult: { estimatedCostUsd: 0 } } as unknown as PipelineRunResult["context"], // test-ratchet-allow: as-unknown-as
};

let origResultSpawn: typeof _resultHandlerDeps.spawn;

beforeEach(() => {
  origResultSpawn = _resultHandlerDeps.spawn;
});

afterEach(() => {
  _resultHandlerDeps.spawn = origResultSpawn;
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handlePipelineFailure — worktree removal drains streams (BUG-12)", () => {
  test("consumes stdout and stderr so >64KB git output cannot stall the child", async () => {
    const story = makeStory({ id: "US-bug12", status: "pending", passes: false, attempts: 2 });
    const ctx = makeCtx(story, {
      config: {
        ...WORKTREE_CONFIG,
        execution: {
          ...WORKTREE_CONFIG.execution,
          rectification: { ...WORKTREE_CONFIG.execution.rectification, maxAttemptsTotal: 1 },
        },
      },
    });

    // BUG-12: the handler awaited `proc.exited` without consuming stdout or
    // stderr. A git error emitting >64KB fills the pipe; the child can never
    // finish writing, and the handler hangs. Reproduce that contract: `exited`
    // only resolves after both streams have been fully read, so an undrained
    // handler trips the deadline race below.
    const encoder = new TextEncoder();
    const bigOutput = "fatal: path is in use\n".repeat(16_384); // ~330KB
    const onRead = (() => {
      let resolveRead!: () => void;
      const promise = new Promise<void>((res) => { resolveRead = res; });
      return { promise, resolveRead };
    })();
    _resultHandlerDeps.spawn = mock(() => ({
      stdout: new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(encoder.encode("warning: dirty worktree\n")); },
        pull(c) { onRead.resolveRead(); c.close(); },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(encoder.encode(bigOutput)); },
        pull(c) { onRead.resolveRead(); c.close(); },
      }),
      // Resolves only once BOTH streams have been read to completion.
      exited: Promise.all([onRead.promise, onRead.promise]).then(() => 0),
      kill: mock(() => {}),
    })) as unknown as typeof _resultHandlerDeps.spawn; // test-ratchet-allow: as-unknown-as (mock spawn cast)

    await Promise.race([
      handlePipelineFailure(ctx, failResult),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("BUG-12: worktree removal hung on undrained streams")), 3000),
      ),
    ]);
  });

  test("logs a warning when git worktree remove exits non-zero", async () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const story = makeStory({ id: "US-bug12", status: "pending", passes: false, attempts: 2 });
    const ctx = makeCtx(story, {
      config: {
        ...WORKTREE_CONFIG,
        execution: {
          ...WORKTREE_CONFIG.execution,
          rectification: { ...WORKTREE_CONFIG.execution.rectification, maxAttemptsTotal: 1 },
        },
      },
    });

    _resultHandlerDeps.spawn = mock(() => {
      const encoder = new TextEncoder();
      return {
        stdout: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode("fatal: worktree is dirty\n")); c.close(); } }),
        exited: Promise.resolve(128),
        kill: mock(() => {}),
      };
    }) as unknown as typeof _resultHandlerDeps.spawn; // test-ratchet-allow: as-unknown-as (mock spawn cast)

    await handlePipelineFailure(ctx, failResult);

    const warnCall = logger.calls.find((c) => c.level === "warn" && String(c.message).includes("worktree"));
    expect(warnCall).toBeDefined();
    expect(warnCall?.data?.exitCode ?? warnCall?.data?.exit ?? warnCall?.data?.code).toBe(128);
    loggerSpy.mockRestore();
  });
});
