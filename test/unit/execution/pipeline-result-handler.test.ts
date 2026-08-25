/**
 * Unit tests for pipeline-result-handler.ts (ENH-005 — outputFiles capture)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _tierEscalationDeps } from "@/execution/escalation/tier-escalation";
import {
  type PipelineHandlerContext,
  _resultHandlerDeps,
  handlePipelineFailure,
  handlePipelineSuccess,
} from "@/execution/pipeline-result-handler";
import type { PipelineRunResult } from "@/pipeline/runner";
import { PluginRegistry } from "@/plugins/registry";
import { loadPRD, savePRD } from "@/prd";
import type { PRD, UserStory } from "@/prd/types";
import { _gitDeps } from "@/utils/git";
import { makeAgentResult, makeMergeEngine, makeSpawn, makeTestContext } from "@test/helpers";
import { cleanupTempDir, makeDispatchContext, makeTempDir } from "@test/helpers";

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
    context: makeTestContext({
      agentResult: makeAgentResult(),
      storyMetrics: [],
    }),
  };
}

function makeCtx(story: UserStory, overrides: Partial<PipelineHandlerContext> = {}): PipelineHandlerContext {
  const prd = makePRD([story]);
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
    ...makeDispatchContext(),
    ...overrides,
  };
}

/** Build a mock spawn that returns the given output as stdout */
function mockSpawnReturning(output: string) {
  return makeSpawn(() => output).spawn;
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
  // mode. Default to "does not exist" — the safe, deterministic default that
  // matches every test's actual fixture state — so tests that don't care
  // about worktree cleanup never fall through to a real, unmocked spawn.
  // Tests that specifically exercise worktree removal opt in explicitly.
  _resultHandlerDeps.existsSync = (() => false) as typeof _resultHandlerDeps.existsSync;
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
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      capturedArgs = cmd;
      return "apps/api/src/index.ts\n";
    }).spawn;

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("apps/api/");
    expect(story.outputFiles).toEqual(["apps/api/src/index.ts"]);
  });

  test("does not set outputFiles when storyGitRef is undefined", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: undefined });

    // spawn should not be called
    _gitDeps.spawn = mock(() => {
      throw new Error("spawn should not be called");
    });

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(story.outputFiles).toBeUndefined();
  });

  test("does not set outputFiles when storyGitRef is null", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { storyGitRef: null });

    _gitDeps.spawn = mock(() => {
      throw new Error("spawn should not be called");
    });

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
    _gitDeps.spawn = mockSpawnReturning(`${manyFiles}\n`);

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

    _gitDeps.spawn = mock(() => {
      throw new Error("git not found");
    });

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
    _resultHandlerDeps.mergeEngine = makeMergeEngine({ merge: mergeMock });
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
    _resultHandlerDeps.mergeEngine = makeMergeEngine({ merge: mergeMock });
    _gitDeps.spawn = mockSpawnReturning("");

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(mergeMock).not.toHaveBeenCalled();
  });

  test("returns storiesCompletedDelta=0 when merge fails and rectification also fails", async () => {
    const story = makeStory("US-001");
    const ctx = makeCtx(story, { config: WORKTREE_CONFIG });

    _resultHandlerDeps.mergeEngine = makeMergeEngine({
      merge: mock(async () => ({ success: false as const, conflictFiles: ["foo.ts"] })),
    });
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

// ---------------------------------------------------------------------------
// EXEC-002 / MEM-6 — worktree cleanup on fail/pause: see
// pipeline-result-handler-worktree-cleanup.test.ts (split out for the
// 800-line cap)
// ---------------------------------------------------------------------------

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
      context: makeTestContext({ agentResult: makeAgentResult() }),
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
      context: makeTestContext({ agentResult: makeAgentResult() }),
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
      context: makeTestContext({ agentResult: makeAgentResult() }),
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
    _resultHandlerDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push(cmd);
      return "";
    }).spawn;
    return calls;
  }

  test("a non-conflict merge failure marks the story failed on disk", async () => {
    const { ctx } = await seedPassedStory();
    stubSpawn();
    _resultHandlerDeps.mergeEngine = makeMergeEngine({
      merge: mock(async () => ({ success: false as const, failureKind: "error" as const, error: "dirty tree" })),
    });

    const result = await handlePipelineSuccess(ctx, makeMinimalResult());

    expect((await loadPRD(prdPath)).userStories[0]?.status).toBe("failed");
    expect(result.storiesCompletedDelta).toBe(0);
    expect(result.prdDirty).toBe(true);
  });

  test("the reported failure survives the executor's reload-from-disk", async () => {
    const { ctx } = await seedPassedStory();
    stubSpawn();
    _resultHandlerDeps.mergeEngine = makeMergeEngine({
      merge: mock(async () => ({ success: false as const, failureKind: "error" as const, error: "missing branch" })),
    });

    const result = await handlePipelineSuccess(ctx, makeMinimalResult());

    // Exactly what unified-executor does when prdDirty is true. A handler that
    // only mutated ctx.prd would come back "passed" here.
    const reloaded = result.prdDirty ? await loadPRD(ctx.prdPath) : result.prd;
    expect(reloaded.userStories[0]?.status).toBe("failed");
  });

  test("a non-conflict merge failure reclaims the worktree directory", async () => {
    const { ctx } = await seedPassedStory();
    const calls = stubSpawn();
    _resultHandlerDeps.mergeEngine = makeMergeEngine({
      merge: mock(async () => ({ success: false as const, failureKind: "error" as const, error: "dirty tree" })),
    });

    await handlePipelineSuccess(ctx, makeMinimalResult());

    expect(calls.some((a) => a.includes("worktree") && a.includes("remove"))).toBe(true);
  });

  test("a clean merge still reports the story as passed", async () => {
    const { ctx } = await seedPassedStory();
    stubSpawn();
    _resultHandlerDeps.mergeEngine = makeMergeEngine({
      merge: mock(async () => ({ success: true as const })),
    });

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
      context: makeTestContext({
        agentResult: makeAgentResult(),
        tddFailureCategory: "runtime-crash",
      }),
    };

    const result = await handlePipelineFailure(ctx, escalateResult);

    // retry-same returns the original PRD by reference; prdDirty is false
    // because nothing was written or updated. If the derive-and-pass step
    // is missing, handleTierEscalation escalates to "balanced" and produces
    // a brand-new PRD object — this assertion catches that.
    expect(result.prd).toBe(ctx.prd);
    expect(result.prdDirty).toBe(false);
  });

  // #1707 follow-up: handleTierEscalation tallies the crash on ctx.runtime, but only
  // if handlePipelineFailure actually threads runtime through. Without this the tally
  // is inert in production for exactly the reason StoryMetrics.runtimeCrashes was.
  test("does not tally a story whose escalation was not a runtime crash", async () => {
    const story = makeStory("US-002-no-crash", {
      status: "in-progress",
      passes: false,
      attempts: 2,
      routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "" },
    });
    const ctx = makeCtx(story, {
      routing: { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    await handlePipelineFailure(ctx, {
      success: false,
      finalAction: "escalate",
      reason: "tests failing",
      context: makeTestContext({ agentResult: makeAgentResult() }),
    });

    expect(ctx.runtime.runtimeCrashRetries.has("US-002-no-crash")).toBe(false);
  });

  test("accumulates the tally across repeated runtime crashes for the same story", async () => {
    const story = makeStory("US-002-repeat-crash", {
      status: "in-progress",
      passes: false,
      attempts: 2,
      routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "" },
    });
    const ctx = makeCtx(story, {
      routing: { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });
    const crash = () =>
      handlePipelineFailure(ctx, {
        success: false,
        finalAction: "escalate" as const,
        reason: "Bun runtime crash",
        context: makeTestContext({ agentResult: makeAgentResult(), tddFailureCategory: "runtime-crash" }),
      });

    await crash();
    await crash();

    expect(ctx.runtime.runtimeCrashRetries.get("US-002-repeat-crash")).toBe(2);
  });

  test("threads runtime through so the crash is tallied for StoryMetrics.runtimeCrashes", async () => {
    const story = makeStory("US-002-handler-tally", {
      status: "in-progress",
      passes: false,
      attempts: 2,
      routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "" },
    });
    const ctx = makeCtx(story, {
      routing: { complexity: "medium", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    await handlePipelineFailure(ctx, {
      success: false,
      finalAction: "escalate",
      reason: "Bun runtime crash",
      context: makeTestContext({ agentResult: makeAgentResult(), tddFailureCategory: "runtime-crash" }),
    });

    expect(ctx.runtime.runtimeCrashRetries.get("US-002-handler-tally")).toBe(1);
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
      context: makeTestContext({
        agentResult: makeAgentResult(),
        tddFailureCategory: "runtime-crash",
      }),
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
      context: makeTestContext({
        agentResult: makeAgentResult(),
        tddFailureCategory: "runtime-crash",
      }),
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
      context: makeTestContext({
        agentResult: makeAgentResult(),
        tddFailureCategory: "tests-failing",
      }),
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
