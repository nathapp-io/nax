/**
 * Unit tests for pipeline-result-handler.ts (ENH-005 — outputFiles capture)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeAgentResult,
  makeDispatchContext,
  makeSpawn,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { _tierEscalationDeps } from "@/execution/escalation/tier-escalation";
import {
  _resultHandlerDeps,
  handlePipelineFailure,
  handlePipelineSuccess,
  type PipelineHandlerContext,
} from "@/execution/pipeline-result-handler";
import type { PipelineRunResult } from "@/pipeline/runner";
import { PluginRegistry } from "@/plugins/registry";
import type { PRD, UserStory } from "@/prd/types";
import { _gitDeps } from "@/utils/git";

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
    prdPath: join(ctxWorkdir, "prd.json"),
    workdir: ctxWorkdir,
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

// The fixture's workdir/prdPath: a real dir under `$TMPDIR`, because the
// handler persists the PRD there (`savePRD` writes `<path>.tmp-<uuid>`), and a
// confined run may not write a literal `/tmp/...`.
let ctxWorkdir: string;

let origSpawn: typeof _gitDeps.spawn;
let origResultSpawn: typeof _resultHandlerDeps.spawn;
let origSavePrd: typeof _tierEscalationDeps.savePrdProgress;
let origExistsSync: typeof _resultHandlerDeps.existsSync;

beforeEach(() => {
  ctxWorkdir = makeTempDir("nax-result-handler-");
  origSpawn = _gitDeps.spawn;
  origResultSpawn = _resultHandlerDeps.spawn;
  origSavePrd = _tierEscalationDeps.savePrdProgress;
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
  _tierEscalationDeps.savePrdProgress = origSavePrd;
  _resultHandlerDeps.existsSync = origExistsSync;
  cleanupTempDir(ctxWorkdir);
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

import type { StorySkippedEvent } from "@/pipeline/event-bus";
import { pipelineEventBus } from "@/pipeline/event-bus";

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
// handlePipelineFailure — an escalate result always advances one rung
//
// The runtime-crash same-tier retry is gone, so every `escalate` result takes
// the ordinary escalation flow: the story moves to the next tier and the
// returned PRD is a new object.
// ---------------------------------------------------------------------------

describe("handlePipelineFailure — an escalate result advances one rung", () => {
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
      }),
    };

    const result = await handlePipelineFailure(ctx, escalateResult);

    // The escalate path takes the ordinary escalation flow: produce a new
    // PRD, advance "fast" → "balanced", mark prdDirty.
    const resultStory = result.prd.userStories.find((s) => s.id === "US-002-handler-10");
    expect(resultStory).toBeDefined();
    expect(resultStory?.routing?.modelTier).toBe("balanced");
    expect(result.prdDirty).toBe(true);
    // And the returned PRD must be a different reference (escalation
    // builds a new userStories array via .map()).
    expect(result.prd).not.toBe(ctx.prd);
  });
});

// ---------------------------------------------------------------------------
// US-001: handlePipelineFailure — the fail action records no failure category
//
// The failure category no longer reaches the escalation layer, so the fail
// path saves the story as failed without stamping a category on it.
// ---------------------------------------------------------------------------

describe("handlePipelineFailure — fail action records no failure category (US-001)", () => {
  test("AC-4: marks the story failed and leaves failureCategory unset", async () => {
    const story = makeStory("US-001-fail", {
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

    const origSavePrdProgress = _resultHandlerDeps.savePrdProgress;
    let savedPrd: PRD | undefined;
    _resultHandlerDeps.savePrdProgress = async (prd) => {
      savedPrd = prd;
    };

    try {
      const result = await handlePipelineFailure(ctx, {
        success: false,
        finalAction: "fail",
        reason: "tests failing",
        // The fail path must not carry a failure category onto the story.
        context: makeTestContext({ agentResult: makeAgentResult() }),
      });

      expect(result.prdDirty).toBe(true);

      assertDefined(savedPrd, "saved prd");
      const savedStory = savedPrd.userStories.find((s) => s.id === "US-001-fail");
      expect(savedStory?.status).toBe("failed");
      expect(savedStory?.failureCategory).toBeUndefined();
    } finally {
      _resultHandlerDeps.savePrdProgress = origSavePrdProgress;
    }
  });
});
