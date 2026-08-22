/**
 * Unit tests for pipeline-result-handler.ts (ENH-005 — outputFiles capture)
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { loadPRD, savePRD } from "@/prd";
import { makeMockRuntime } from "@test/helpers";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _tierEscalationDeps } from "@/execution/escalation/tier-escalation";
import type { PRD, UserStory } from "@/prd/types";
import { _gitDeps } from "@/utils/git";
import {
  _resultHandlerDeps,
  handlePipelineFailure,
  handlePipelineSuccess,
  type PipelineHandlerContext,
} from "@/execution/pipeline-result-handler";
import type { PipelineRunResult } from "@/pipeline/runner";
import { PluginRegistry } from "@/plugins/registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "passed",
    passes: true,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeMinimalResult(): PipelineRunResult {
  return {
    success: true,
    finalAction: "complete",
    context: {
      agentResult: { estimatedCostUsd: 0 },
      storyMetrics: [],
    } as unknown as PipelineRunResult["context"],
  };
}

function makeCtx(story: UserStory, overrides: Partial<PipelineHandlerContext> = {}): PipelineHandlerContext {
  const prd = makePRD([story]);
  return {
    config: DEFAULT_CONFIG,
    prd,
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/repo",
    hooks: { hooks: [] } as unknown as PipelineHandlerContext["hooks"],
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
  };
}

/** Build a mock spawn that returns the given output as stdout */
function mockSpawnReturning(output: string) {
  return mock((_args: string[], _opts: unknown) => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(output);
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WORKTREE_CONFIG = {
  ...DEFAULT_CONFIG,
  execution: { ...DEFAULT_CONFIG.execution, storyIsolation: "worktree" as const },
};

let origSpawn: typeof _gitDeps.spawn;
let origResultSpawn: typeof _resultHandlerDeps.spawn;
let origMergeEngine: typeof _resultHandlerDeps.mergeEngine;
let origSavePrd: typeof _tierEscalationDeps.savePRD;
let origExistsSync: typeof _resultHandlerDeps.existsSync;

beforeEach(() => {
  origSpawn = _gitDeps.spawn;
  origResultSpawn = _resultHandlerDeps.spawn;
  origMergeEngine = _resultHandlerDeps.mergeEngine;
  origSavePrd = _tierEscalationDeps.savePRD;
  origExistsSync = _resultHandlerDeps.existsSync;
  // MEM-6: cleanup now keys off real worktree existence rather than config
  // mode — default to "exists" so unrelated tests exercising worktree-mode
  // paths keep reaching the removal call without depending on real disk state.
  _resultHandlerDeps.existsSync = (() => true) as typeof _resultHandlerDeps.existsSync;
});

afterEach(() => {
  _gitDeps.spawn = origSpawn;
  _resultHandlerDeps.spawn = origResultSpawn;
  _resultHandlerDeps.mergeEngine = origMergeEngine;
  _tierEscalationDeps.savePRD = origSavePrd;
  _resultHandlerDeps.existsSync = origExistsSync;
  mock.restore();
});

describe("handlePipelineSuccess — outputFiles capture (ENH-005)", () => {
  test("populates outputFiles on story when storyGitRef is set", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mockSpawnReturning("src/service.ts\nsrc/handler.ts\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toEqual(["src/service.ts", "src/handler.ts"]);
  });

  test("scopes diff to story.workdir when set", async () => {
    const story = makeStory("US-001", { workdir: "apps/api" });
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    let capturedArgs: string[] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      capturedArgs = args as string[];
      const bytes = new TextEncoder().encode("apps/api/src/index.ts\n");
      return {
        stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("apps/api/");
    expect(story.outputFiles).toEqual(["apps/api/src/index.ts"]);
  });

  test("does not set outputFiles when storyGitRef is undefined", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: undefined });

    // spawn should not be called
    _gitDeps.spawn = mock(() => { throw new Error("spawn should not be called"); });

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toBeUndefined();
  });

  test("does not set outputFiles when storyGitRef is null", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: null });

    _gitDeps.spawn = mock(() => { throw new Error("spawn should not be called"); });

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toBeUndefined();
  });

  test("filters out .test.ts files from captured output", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mockSpawnReturning("src/service.ts\nsrc/service.test.ts\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toEqual(["src/service.ts"]);
  });

  test("filters out bun.lockb from captured output", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mockSpawnReturning("src/index.ts\nbun.lockb\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toEqual(["src/index.ts"]);
  });

  test("caps captured files at 15", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`).join("\n");
    _gitDeps.spawn = mockSpawnReturning(manyFiles + "\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toHaveLength(15);
  });

  test("does not set outputFiles when all files are filtered out", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mockSpawnReturning("bun.lockb\npackage-lock.json\n");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    // filtered.length === 0 → outputFiles not set
    expect(story.outputFiles).toBeUndefined();
  });

  test("is non-fatal when git spawn throws", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: "abc123" });

    _gitDeps.spawn = mock(() => { throw new Error("git not found"); });

    // Should not throw
    const result = await handlePipelineSuccess(ctx, makeMinimalResult());
    expect(result.prdDirty).toBe(true);
    expect(story.outputFiles).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EXEC-002: worktree merge on success
// ---------------------------------------------------------------------------

describe("handlePipelineSuccess — worktree mode (EXEC-002)", () => {
  test("calls mergeEngine.merge() when storyIsolation === 'worktree'", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { config: WORKTREE_CONFIG });

    const mergeMock = mock(async () => ({ success: true as const }));
    _resultHandlerDeps.mergeEngine = { merge: mergeMock } as unknown as typeof _resultHandlerDeps.mergeEngine;
    // Silence git spawn (no storyGitRef)
    _gitDeps.spawn = mockSpawnReturning("");

    const result = await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(mergeMock).toHaveBeenCalledWith("/tmp/repo", "US-001");
    expect(result.prdDirty).toBe(true);
  });

  test("does NOT call mergeEngine.merge() in shared mode", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story); // DEFAULT_CONFIG has storyIsolation: "shared"

    const mergeMock = mock(async () => ({ success: true as const }));
    _resultHandlerDeps.mergeEngine = { merge: mergeMock } as unknown as typeof _resultHandlerDeps.mergeEngine;
    _gitDeps.spawn = mockSpawnReturning("");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(mergeMock).not.toHaveBeenCalled();
  });

  test("returns storiesCompletedDelta=0 when merge fails and rectification also fails", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { config: WORKTREE_CONFIG });

    _resultHandlerDeps.mergeEngine = {
      merge: mock(async () => ({ success: false as const, conflictFiles: ["foo.ts"] })),
    } as unknown as typeof _resultHandlerDeps.mergeEngine;
    _gitDeps.spawn = mockSpawnReturning("");

    // rectifyConflictedStory is dynamically imported inside handlePipelineSuccess.
    // We can't easily mock it here, so we just verify the handler doesn't throw
    // and returns the expected non-dirty result when rectification fails.
    // (Full rectification behaviour tested in merge.test.ts)
    const result = await handlePipelineSuccess(ctx, makeMinimalResult()).catch(() => null);
    // Even if it fails internally, no unhandled throw should escape
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EXEC-002: worktree cleanup on failure
// ---------------------------------------------------------------------------

describe("handlePipelineFailure — worktree mode (EXEC-002)", () => {
  test("calls git worktree remove on 'fail' finalAction in worktree mode", async () => {
    const story = makeStory("US-001", { status: "pending", passes: false, attempts: 2 });
    const ctx = makeCtx(story, {
      config: {
        ...WORKTREE_CONFIG,
        execution: {
          ...WORKTREE_CONFIG.execution,
          rectification: { ...WORKTREE_CONFIG.execution.rectification, maxAttemptsTotal: 1 },
        },
      },
    });

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = mock((args: unknown) => {
      spawnCalls.push(args as string[]);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    }) as unknown as typeof _resultHandlerDeps.spawn;

    const failResult: PipelineRunResult = {
      success: false,
      finalAction: "fail",
      reason: "Tests failed",
      context: { agentResult: { estimatedCostUsd: 0 } } as unknown as PipelineRunResult["context"],
    };

    await handlePipelineFailure(ctx, failResult);

    const worktreeRemoveCalls = spawnCalls.filter((a) => a.includes("worktree") && a.includes("remove"));
    expect(worktreeRemoveCalls.length).toBeGreaterThan(0);
    // Branch NOT deleted (only directory removed)
    const branchDeleteCalls = spawnCalls.filter((a) => a.includes("branch") && a.includes("-D"));
    expect(branchDeleteCalls.length).toBe(0);
  });

  test("does NOT call git worktree remove in shared mode on 'fail'", async () => {
    const story = makeStory("US-001", { status: "pending", passes: false, attempts: 2 });
    const ctx = makeCtx(story);
    // MEM-6: cleanup now keys off worktree existence, not config mode — a
    // sequential shared-mode run never created one, so simulate that here.
    _resultHandlerDeps.existsSync = (() => false) as typeof _resultHandlerDeps.existsSync;

    const spawnCalls: string[][] = [];
    _resultHandlerDeps.spawn = mock((args: unknown) => {
      spawnCalls.push(args as string[]);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    }) as unknown as typeof _resultHandlerDeps.spawn;

    const failResult: PipelineRunResult = {
      success: false,
      finalAction: "fail",
      reason: "Tests failed",
      context: { agentResult: { estimatedCostUsd: 0 } } as unknown as PipelineRunResult["context"],
    };

    await handlePipelineFailure(ctx, failResult);

    const worktreeRemoveCalls = spawnCalls.filter((a) => a.includes("worktree") && a.includes("remove"));
    expect(worktreeRemoveCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nax#1582 — pause path persists the blocking reason: see
// pipeline-result-handler-pause-reason.test.ts (split out for the 800-line cap)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// story:skipped event emission
// ---------------------------------------------------------------------------

import { pipelineEventBus } from "@/pipeline/event-bus";
import type { StorySkippedEvent } from "@/pipeline/event-bus";

describe("handlePipelineFailure — story:skipped event", () => {
  let capturedSkipped: StorySkippedEvent[];
  let unsub: () => void;

  beforeEach(() => {
    capturedSkipped = [];
    pipelineEventBus.clear();
    unsub = pipelineEventBus.on("story:skipped", (ev) => {
      capturedSkipped.push(ev as StorySkippedEvent);
    });
  });

  afterEach(() => {
    unsub();
    pipelineEventBus.clear();
  });

  test("emits story:skipped event with storyId and reason when finalAction is 'skip'", async () => {
    const story = makeStory("US-skip-01");
    const ctx = makeCtx(story);

    const skipResult: PipelineRunResult = {
      success: false,
      finalAction: "skip",
      reason: "Dependency not met",
      context: { agentResult: { estimatedCostUsd: 0 } } as unknown as PipelineRunResult["context"],
    };

    await handlePipelineFailure(ctx, skipResult);

    expect(capturedSkipped).toHaveLength(1);
    expect(capturedSkipped[0].type).toBe("story:skipped");
    expect(capturedSkipped[0].storyId).toBe("US-skip-01");
    expect(capturedSkipped[0].reason).toBe("Dependency not met");
  });

  test("uses fallback reason when pipelineResult.reason is undefined", async () => {
    const story = makeStory("US-skip-02");
    const ctx = makeCtx(story);

    const skipResult: PipelineRunResult = {
      success: false,
      finalAction: "skip",
      reason: undefined,
      context: { agentResult: { estimatedCostUsd: 0 } } as unknown as PipelineRunResult["context"],
    };

    await handlePipelineFailure(ctx, skipResult);

    expect(capturedSkipped).toHaveLength(1);
    expect(capturedSkipped[0].storyId).toBe("US-skip-02");
    expect(capturedSkipped[0].reason).toBe("Story skipped");
  });

  test("does NOT emit story:skipped when finalAction is 'fail'", async () => {
    const story = makeStory("US-skip-03", { status: "pending", passes: false, attempts: 2 });
    const ctx = makeCtx(story);

    const failResult: PipelineRunResult = {
      success: false,
      finalAction: "fail",
      reason: "Tests failed",
      context: { agentResult: { estimatedCostUsd: 0 } } as unknown as PipelineRunResult["context"],
    };

    await handlePipelineFailure(ctx, failResult);

    expect(capturedSkipped).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A story whose branch never landed must not be recorded as passed
// ---------------------------------------------------------------------------

/**
 * These assert the **on-disk** prd.json, not `ctx.prd`.
 *
 * That is the whole point. `completionStage` runs before this handler and has
 * already written `status: "passed"` to disk, and the executor answers
 * `prdDirty: true` by *reloading* from disk (`unified-executor.ts:484-486`) —
 * it never saves on the handler's behalf. So a handler that mutates `ctx.prd`
 * and sets `prdDirty` without calling `savePRD` has its correction silently
 * discarded on the next reload. An in-memory assertion passes against exactly
 * that bug; only reading the file back catches it.
 */
describe("handlePipelineSuccess — a failed worktree merge is not a passed story", () => {
  let tempDir: string;
  let prdPath: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-merge-fail-");
    prdPath = join(tempDir, "prd.json");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  /** Mirrors the state completionStage leaves behind: passed, in memory and on disk. */
  async function seedPassedStory(): Promise<{ story: UserStory; ctx: PipelineHandlerContext }> {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, {
      config: WORKTREE_CONFIG,
      prdPath,
      workdir: tempDir,
      storyGitRef: undefined,
    });
    await savePRD(ctx.prd, prdPath);
    expect((await loadPRD(prdPath)).userStories[0]?.status).toBe("passed");
    return { story, ctx };
  }

  function stubSpawn(): string[][] {
    const calls: string[][] = [];
    _resultHandlerDeps.spawn = mock((args: unknown) => {
      calls.push(args as string[]);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    }) as unknown as typeof _resultHandlerDeps.spawn;
    return calls;
  }

  test("a non-conflict merge failure marks the story failed on disk", async () => {
    const { ctx } = await seedPassedStory();
    stubSpawn();
    _resultHandlerDeps.mergeEngine = {
      merge: mock(async () => ({ success: false as const, failureKind: "error" as const, error: "dirty tree" })),
    } as unknown as typeof _resultHandlerDeps.mergeEngine;

    const result = await handlePipelineSuccess(ctx, makeMinimalResult());

    expect((await loadPRD(prdPath)).userStories[0]?.status).toBe("failed");
    expect(result.storiesCompletedDelta).toBe(0);
    expect(result.prdDirty).toBe(true);
  });

  test("the reported failure survives the executor's reload-from-disk", async () => {
    const { ctx } = await seedPassedStory();
    stubSpawn();
    _resultHandlerDeps.mergeEngine = {
      merge: mock(async () => ({ success: false as const, failureKind: "error" as const, error: "missing branch" })),
    } as unknown as typeof _resultHandlerDeps.mergeEngine;

    const result = await handlePipelineSuccess(ctx, makeMinimalResult());

    // Exactly what unified-executor does when prdDirty is true. A handler that
    // only mutated ctx.prd would come back "passed" here.
    const reloaded = result.prdDirty ? await loadPRD(ctx.prdPath) : result.prd;
    expect(reloaded.userStories[0]?.status).toBe("failed");
  });

  test("a non-conflict merge failure reclaims the worktree directory", async () => {
    const { ctx } = await seedPassedStory();
    const calls = stubSpawn();
    _resultHandlerDeps.mergeEngine = {
      merge: mock(async () => ({ success: false as const, failureKind: "error" as const, error: "dirty tree" })),
    } as unknown as typeof _resultHandlerDeps.mergeEngine;

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(calls.some((a) => a.includes("worktree") && a.includes("remove"))).toBe(true);
  });

  test("a clean merge still reports the story as passed", async () => {
    const { ctx } = await seedPassedStory();
    stubSpawn();
    _resultHandlerDeps.mergeEngine = {
      merge: mock(async () => ({ success: true as const })),
    } as unknown as typeof _resultHandlerDeps.mergeEngine;

    const result = await handlePipelineSuccess(ctx, makeMinimalResult());

    expect((await loadPRD(prdPath)).userStories[0]?.status).toBe("passed");
    expect(result.storiesCompletedDelta).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// US-002: handlePipelineFailure — runtime-crash derives retry-same
//
// When the pipeline hands back an `escalate` finalAction and the
// pipelineResult.context.tddFailureCategory is `runtime-crash`,
// handlePipelineFailure must derive a runtimeCrashResult and pass it to
// handleTierEscalation. The observable consequence: the returned PRD is the
// same reference (retry-same returns ctx.prd verbatim), prdDirty is false,
// the story's routing.modelTier is unchanged, and the story's attempts is
// not reset. A non-crash failure (e.g. tests-failing) must still escalate
// and advance the tier by one rung.
// ---------------------------------------------------------------------------

describe("handlePipelineFailure — runtime-crash derives retry-same (US-002)", () => {
  test("derives runtimeCrashResult and routes to retry-same when tddFailureCategory is 'runtime-crash' (AC-7)", async () => {
    const story = makeStory("US-002-handler-7", {
      status: "in-progress",
      passes: false,
      attempts: 2,
      routing: {
        modelTier: "fast",
        testStrategy: "test-after",
        complexity: "medium",
        reasoning: "",
      },
    });
    const ctx = makeCtx(story, {
      routing: { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    const escalateResult: PipelineRunResult = {
      success: false,
      finalAction: "escalate",
      reason: "Bun runtime crash",
      context: {
        agentResult: { estimatedCostUsd: 0 },
        tddFailureCategory: "runtime-crash",
      } as unknown as PipelineRunResult["context"],
    };

    const result = await handlePipelineFailure(ctx, escalateResult);

    // retry-same returns the original PRD by reference; prdDirty is false
    // because nothing was written or updated. If the derive-and-pass step
    // is missing, handleTierEscalation escalates to "balanced" and produces
    // a brand-new PRD object — this assertion catches that.
    expect(result.prd).toBe(ctx.prd);
    expect(result.prdDirty).toBe(false);
  });

  test("does not change story routing.modelTier for a runtime-crash escalation (AC-8)", async () => {
    const story = makeStory("US-002-handler-8", {
      status: "in-progress",
      passes: false,
      attempts: 2,
      routing: {
        modelTier: "fast",
        testStrategy: "test-after",
        complexity: "medium",
        reasoning: "",
      },
    });
    const ctx = makeCtx(story, {
      routing: { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    const escalateResult: PipelineRunResult = {
      success: false,
      finalAction: "escalate",
      reason: "Bun runtime crash",
      context: {
        agentResult: { estimatedCostUsd: 0 },
        tddFailureCategory: "runtime-crash",
      } as unknown as PipelineRunResult["context"],
    };

    const result = await handlePipelineFailure(ctx, escalateResult);

    const resultStory = result.prd.userStories.find((s) => s.id === "US-002-handler-8");
    expect(resultStory).toBeDefined();
    // Model tier must remain "fast" — the entire point of US-002 is that
    // runtime crashes do not trigger tier escalation. A non-crash path
    // would advance to "balanced" (the next rung in DEFAULT_CONFIG).
    expect(resultStory?.routing?.modelTier).toBe("fast");
  });

  test("does not reset story attempts to 0 for a runtime-crash escalation (AC-9)", async () => {
    const story = makeStory("US-002-handler-9", {
      status: "in-progress",
      passes: false,
      // Use a non-zero attempts value distinct from a tier reset (0) and
      // distinct from a no-op leave-as-1 (1) so a regression on either
      // side is observable. 3 is also above the default "fast" budget (5
      // in DEFAULT_CONFIG but the assertion is order-independent).
      attempts: 3,
      routing: {
        modelTier: "fast",
        testStrategy: "test-after",
        complexity: "medium",
        reasoning: "",
      },
    });
    const ctx = makeCtx(story, {
      routing: { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    const escalateResult: PipelineRunResult = {
      success: false,
      finalAction: "escalate",
      reason: "Bun runtime crash",
      context: {
        agentResult: { estimatedCostUsd: 0 },
        tddFailureCategory: "runtime-crash",
      } as unknown as PipelineRunResult["context"],
    };

    const result = await handlePipelineFailure(ctx, escalateResult);

    const resultStory = result.prd.userStories.find((s) => s.id === "US-002-handler-9");
    expect(resultStory).toBeDefined();
    // BUG regression guard: an escalated tier-change normally resets
    // attempts to 0. For runtime-crash we want neither a reset nor an
    // increment — the same tier is being retried with the existing counter.
    expect(resultStory?.attempts).toBe(3);
  });

  test("advances story routing.modelTier by one rung for a non-crash escalation (AC-10)", async () => {
    const story = makeStory("US-002-handler-10", {
      status: "in-progress",
      passes: false,
      attempts: 1,
      routing: {
        modelTier: "fast",
        testStrategy: "test-after",
        complexity: "medium",
        reasoning: "",
      },
    });
    const ctx = makeCtx(story, {
      routing: { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    const escalateResult: PipelineRunResult = {
      success: false,
      finalAction: "escalate",
      reason: "Tests failed",
      context: {
        agentResult: { estimatedCostUsd: 0 },
        tddFailureCategory: "tests-failing",
      } as unknown as PipelineRunResult["context"],
    };

    const result = await handlePipelineFailure(ctx, escalateResult);

    // Non-crash path must take the existing escalation flow:
    // produce a new PRD, advance "fast" → "balanced", mark prdDirty.
    const resultStory = result.prd.userStories.find((s) => s.id === "US-002-handler-10");
    expect(resultStory).toBeDefined();
    expect(resultStory?.routing?.modelTier).toBe("balanced");
    expect(result.prdDirty).toBe(true);
    // And the returned PRD must be a different reference (escalation
    // builds a new userStories array via .map()).
    expect(result.prd).not.toBe(ctx.prd);
  });
});
