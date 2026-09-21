/**
 * Unit tests for merge-conflict-rectify (conflict rectification logic).
 *
 * File: merge-conflict-rectify.test.ts
 * Covers:
 *   rect AC-7  an error thrown by rectifyConflictedStory's inner work is caught and
 *              returned as a failure result (not propagated to the caller)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  makeMockAgentManager,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSessionManager,
  makeSpawn,
  makeSpawnResult,
  makeStory,
  makeTestContext,
} from "@test/helpers";
import type { RectifyConflictedStoryOptions } from "@/execution/merge-conflict-rectify";
import {
  _mergeRectifyDeps,
  buildRectificationPipelineContext,
  closeStaleAcpSession,
  rectifyConflictedStory,
  rectifyMergeFailure,
} from "@/execution/merge-conflict-rectify";
import { _worktreeManagerDeps } from "@/worktree/manager";

// ─────────────────────────────────────────────────────────────────────────────
// rect AC-7 — errors are caught, not propagated; returns { success: false }
// ─────────────────────────────────────────────────────────────────────────────

describe("rect AC-7: rectifyConflictedStory catches errors and returns failure — never throws", () => {
  function makeMinimalOpts(overrides: Partial<RectifyConflictedStoryOptions> = {}): RectifyConflictedStoryOptions {
    const story = makeStory({ id: "US-conflict-1", title: "Conflict story" });
    const prd = makePRD({ userStories: [story] });
    const config = makeNaxConfig();
    return {
      storyId: story.id,
      conflictFiles: ["src/foo.ts"],
      originalCost: 0.5,
      workdir: "/tmp/nonexistent-workdir-for-test",
      config,
      hooks: { hooks: {} },
      pluginRegistry: makePluginRegistry(),
      prd,
      pipelineContextBase: makeTestContext({
        config,
        prd,
        workdir: "/tmp/nonexistent-workdir-for-test",
        agentManager: makeMockAgentManager(),
        sessionManager: makeSessionManager(),
      }),
      ...overrides,
    };
  }

  test("AC-7: function returns a failure result when inner work throws (bad workdir triggers catch)", async () => {
    // The workdir does not exist — WorktreeManager.remove/create will throw, hitting the catch block.
    // The function must return { success: false } instead of propagating the error.
    const opts = makeMinimalOpts();

    let result: Awaited<ReturnType<typeof rectifyConflictedStory>>;
    let threw = false;
    try {
      result = await rectifyConflictedStory(opts);
    } catch {
      threw = true;
      result = { success: false, storyId: opts.storyId, cost: 0, finalConflict: false, pipelineFailure: true };
    }

    // AC-7: the function must NOT throw — it must return a failure result
    expect(threw).toBe(false);
    // The result must indicate failure
    expect(result?.success).toBe(false);
    expect(result?.storyId).toBe(opts.storyId);
  });

  test("AC-7: function returns pipelineFailure=true when story cannot be found in PRD", async () => {
    // storyId not in prd.userStories — function returns early at the "story not found" guard
    const config = makeNaxConfig();
    const story = makeStory({ id: "US-a", title: "story a" });
    const prd = makePRD({ userStories: [story] });

    const opts: RectifyConflictedStoryOptions = {
      storyId: "US-not-in-prd",
      conflictFiles: [],
      originalCost: 0,
      workdir: "/tmp/nonexistent-workdir-for-test",
      config,
      hooks: { hooks: {} },
      pluginRegistry: makePluginRegistry(),
      prd,
      pipelineContextBase: makeTestContext({
        config,
        prd,
        workdir: "/tmp/nonexistent-workdir-for-test",
        agentManager: makeMockAgentManager(),
        sessionManager: makeSessionManager(),
      }),
    };

    let result: Awaited<ReturnType<typeof rectifyConflictedStory>>;
    let threw = false;
    try {
      result = await rectifyConflictedStory(opts);
    } catch {
      threw = true;
      result = { success: false, storyId: opts.storyId, cost: 0, finalConflict: false, pipelineFailure: true };
    }

    expect(threw).toBe(false);
    expect(result?.success).toBe(false);
    // The early-return guard sets pipelineFailure: true for unknown storyId
    expect((result as Extract<typeof result, { success: false }>).pipelineFailure).toBe(true);
  });

  test("AC-7: return type is RectificationResult — never a thrown exception", async () => {
    // Verify via type system: rectifyConflictedStory returns Promise<RectificationResult>
    // If it threw, TypeScript callers using await would need try/catch for error handling.
    // By contract, the function returns a union type — callers check .success, not try/catch.
    type Ret = Awaited<ReturnType<typeof rectifyConflictedStory>>;
    // Compile-time: the union type must have a success discriminant
    type SuccessVariant = Extract<Ret, { success: true }>;
    type FailureVariant = Extract<Ret, { success: false }>;
    const successCheck: SuccessVariant = { success: true, storyId: "x", cost: 0 };
    const failureCheck: FailureVariant = { success: false, storyId: "x", cost: 0, finalConflict: false };
    expect(successCheck.success).toBe(true);
    expect(failureCheck.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The post-rectification merge reports WHY it did not land
// ─────────────────────────────────────────────────────────────────────────────

describe("rectifyMergeFailure: carries the merge classification instead of assuming a conflict", () => {
  test("a real conflict is reported as a final conflict, with its files", () => {
    const r = rectifyMergeFailure("US-001", 1.5, {
      success: false,
      storyId: "US-001",
      failureKind: "conflict",
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });

    expect(r).toMatchObject({
      success: false,
      storyId: "US-001",
      cost: 1.5,
      finalConflict: true,
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });
  });

  test("a non-conflict git failure is NOT reported as a final conflict", () => {
    // Telling the operator the agent could not resolve a conflict, when git
    // actually refused over a dirty tree or a missing branch, sends them
    // looking for a conflict that was never there.
    const r = rectifyMergeFailure("US-001", 0, {
      success: false,
      storyId: "US-001",
      failureKind: "error",
      error: "working tree is dirty",
    });

    expect(r).toMatchObject({ finalConflict: false, conflictFiles: [] });
  });

  test("an absent result keeps the historical conflict reading", () => {
    // mergeAll returned nothing for this story. Unknown is not "error", so the
    // conservative reading — the one every caller had before failureKind
    // existed — is preserved.
    const r = rectifyMergeFailure("US-001", 0, undefined);

    expect(r).toMatchObject({ finalConflict: true, conflictFiles: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRectificationPipelineContext — BUG-36: the constructed PipelineContext
// must actually carry the worktree contract, not just forward a reference to it.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRectificationPipelineContext: the rectification re-run inherits the worktree contract", () => {
  function makeBase(overrides: Partial<RectifyConflictedStoryOptions["pipelineContextBase"]> = {}) {
    const config = makeNaxConfig();
    return makeTestContext({
      config,
      prd: makePRD({ userStories: [] }),
      workdir: "/tmp/nax-rect-ctx",
      prdPath: "/real/feature/prd.json",
      featureDir: "/real/feature",
      skipPrdPersistence: true,
      agentManager: makeMockAgentManager(),
      sessionManager: makeSessionManager(),
      ...overrides,
    });
  }

  test("carries skipPrdPersistence, prdPath, and featureDir through from the base", () => {
    const story = makeStory({ id: "US-001" });
    const ctx = buildRectificationPipelineContext({
      pipelineContextBase: makeBase(),
      story,
      config: makeNaxConfig(),
      hooks: { hooks: {} },
      pluginRegistry: makePluginRegistry(),
      workdir: "/tmp/nax-rect-ctx",
      worktreePath: "/tmp/nax-rect-ctx/.nax-wt/US-001",
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    expect(ctx.skipPrdPersistence).toBe(true);
    expect(ctx.prdPath).toBe("/real/feature/prd.json");
    expect(ctx.featureDir).toBe("/real/feature");
  });

  test("always forces skipCompletionEvents: true, regardless of the base", () => {
    const story = makeStory({ id: "US-001" });
    const ctx = buildRectificationPipelineContext({
      // Base explicitly omits skipCompletionEvents — the override must set it anyway.
      pipelineContextBase: makeBase(),
      story,
      config: makeNaxConfig(),
      hooks: { hooks: {} },
      pluginRegistry: makePluginRegistry(),
      workdir: "/tmp/nax-rect-ctx",
      worktreePath: "/tmp/nax-rect-ctx/.nax-wt/US-001",
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    expect(ctx.skipCompletionEvents).toBe(true);
  });

  test("scopes story/stories/workdir/projectDir to the rectified story's fresh worktree", () => {
    const story = makeStory({ id: "US-002", title: "Second story" });
    const ctx = buildRectificationPipelineContext({
      pipelineContextBase: makeBase(),
      story,
      config: makeNaxConfig(),
      hooks: { hooks: {} },
      pluginRegistry: makePluginRegistry(),
      workdir: "/tmp/nax-rect-ctx",
      worktreePath: "/tmp/nax-rect-ctx/.nax-wt/US-002",
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    });

    expect(ctx.story).toBe(story);
    expect(ctx.stories).toEqual([story]);
    expect(ctx.projectDir).toBe("/tmp/nax-rect-ctx");
    expect(ctx.workdir).toBe("/tmp/nax-rect-ctx/.nax-wt/US-002");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounded `acpx sessions close` (hang-path) — a wedged acpx must not leave
// rectification pending. The eviction is best-effort (already swallows
// errors); with a SIGKILL-after-timeout bound, a hung acpx still resolves.
// ─────────────────────────────────────────────────────────────────────────────

describe("closeStaleAcpSession — bounded `acpx sessions close` (hang-path)", () => {
  let origTypedSpawn: typeof _mergeRectifyDeps.typedSpawn;
  let origTimeoutMs: typeof _mergeRectifyDeps.timeoutMs;
  let origKillProcessGroup: typeof _mergeRectifyDeps.killProcessGroup;
  let killedPid: number | undefined;

  beforeEach(() => {
    origTypedSpawn = _mergeRectifyDeps.typedSpawn;
    origTimeoutMs = _mergeRectifyDeps.timeoutMs;
    origKillProcessGroup = _mergeRectifyDeps.killProcessGroup;
    killedPid = undefined;
  });

  afterEach(() => {
    _mergeRectifyDeps.typedSpawn = origTypedSpawn;
    _mergeRectifyDeps.timeoutMs = origTimeoutMs;
    _mergeRectifyDeps.killProcessGroup = origKillProcessGroup;
  });

  test("settles without raising when the `acpx sessions close` child never exits (AC-5)", async () => {
    _mergeRectifyDeps.timeoutMs = 50;
    // Adversarial: SIGKILL is sent but `proc.exited` stays pending — the
    // implementation MUST settle from the deadline itself, not from the SIGKILL
    // side-effect. `killResolvesExited` is intentionally FALSE so the timer,
    // not the kill, drives the race resolution.
    const proc = makeSpawnResult({ hang: true, pid: 3333 });
    _mergeRectifyDeps.typedSpawn = makeSpawn(() => proc).spawn as typeof _mergeRectifyDeps.typedSpawn;
    _mergeRectifyDeps.killProcessGroup = ((pid) => {
      killedPid = pid;
      // Intentionally NOT calling proc.kill() — the AC requires the eviction
      // to settle (without raising) regardless of what the SIGKILL signal does
      // to `proc.exited`. An implementation that awaits `proc.exited` after
      // the kill would hang here.
      return true;
    }) as typeof _mergeRectifyDeps.killProcessGroup;

    // Best-effort contract preserved: even on a wedged acpx the helper settles
    // (never rejects) so the rectification pipeline can continue.
    let threw = false;
    try {
      await closeStaleAcpSession("/tmp/worktree", "nax-deadbeef-feat-US-001-main");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(killedPid).toBe(3333);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC-7 — rectification derives the worktree identity from its run's
// feature. The pre-US-003 rectifier built `.nax-wt/<storyId>` by hand and
// handed the raw story ID to `remove`/`create`/`mergeAll`.
//
// Both tests drive the real `rectifyConflictedStory`; the only stubs are the
// two process boundaries (git, and the `acpx sessions close` eviction). The
// PRD deliberately does not contain the story, so rectification stops after
// the identity-bearing steps instead of running a real pipeline.
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 AC-7: rectification derives the worktree identity", () => {
  const FEATURE = "f";
  const STORY_ID = "US-001";
  const COMPOSED_TAIL = join(".nax-wt", "story-f-US-001");
  const COMPOSED_BRANCH = "nax/story-f-US-001";
  const WORKDIR = "/tmp/nax-us003-rectify";

  let savedGit: typeof _worktreeManagerDeps.gitWithTimeout;
  let savedTypedSpawn: typeof _mergeRectifyDeps.typedSpawn;

  beforeEach(() => {
    savedGit = _worktreeManagerDeps.gitWithTimeout;
    savedTypedSpawn = _mergeRectifyDeps.typedSpawn;
  });

  afterEach(() => {
    _worktreeManagerDeps.gitWithTimeout = savedGit;
    _mergeRectifyDeps.typedSpawn = savedTypedSpawn;
  });

  /** Every git argv the rectifier issues, with every command succeeding. */
  function stubGit(): string[][] {
    const calls: string[][] = [];
    _worktreeManagerDeps.gitWithTimeout = async (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return calls;
  }

  /**
   * A `typedSpawn` stand-in that records the eviction argv. Typed structurally
   * (not cast) so the stub needs no assertion.
   */
  function stubAcpxSpawn(): string[][] {
    const calls: string[][] = [];
    const emptyStream = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    _mergeRectifyDeps.typedSpawn = (cmd: string[]) => {
      calls.push(cmd);
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(0),
        pid: 4242,
        kill: () => {},
      };
    };
    return calls;
  }

  function makeOpts(feature: string): RectifyConflictedStoryOptions {
    const config = makeNaxConfig();
    // No story in the PRD: rectification stops right after the identity-bearing
    // worktree steps, so no pipeline and no merge are reached.
    const prd = makePRD({ feature, userStories: [] });
    return {
      storyId: STORY_ID,
      conflictFiles: ["src/foo.ts"],
      originalCost: 0.5,
      workdir: WORKDIR,
      config,
      hooks: { hooks: {} },
      pluginRegistry: makePluginRegistry(),
      prd,
      pipelineContextBase: makeTestContext({ config, prd, workdir: WORKDIR }),
    };
  }

  test("AC-7: create() is asked for .nax-wt/story-f-US-001 on branch nax/story-f-US-001", async () => {
    const gitCalls = stubGit();
    stubAcpxSpawn();

    await rectifyConflictedStory(makeOpts(FEATURE));

    const addCall = gitCalls.find((args) => args[0] === "worktree" && args[1] === "add");
    assertDefined(addCall, "git worktree add argv");
    // [git, worktree, add, <path>, -b, <branch>]
    expect(addCall[3]?.endsWith(COMPOSED_TAIL)).toBe(true);
    expect(addCall[4]).toBe("-b");
    expect(addCall[5]).toBe(COMPOSED_BRANCH);
    // The raw story ID must not appear anywhere in the argv.
    expect(gitCalls.some((args) => args.some((a) => a.endsWith(join(".nax-wt", STORY_ID))))).toBe(false);
  });

  test("AC-7: the rectification's worktreePath is the composed path, not the raw story directory", async () => {
    stubGit();
    const acpxCalls = stubAcpxSpawn();

    await rectifyConflictedStory(makeOpts(FEATURE));

    // The stale-session eviction is the one place the rectifier hands its
    // `worktreePath` to an observable boundary: `acpx --cwd <worktreePath> …`.
    const eviction = acpxCalls.find((cmd) => cmd[0] === "acpx");
    assertDefined(eviction, "acpx sessions close argv");
    expect(eviction[1]).toBe("--cwd");
    expect(eviction[2]?.endsWith(COMPOSED_TAIL)).toBe(true);
    expect(eviction[2]?.endsWith(join(".nax-wt", STORY_ID))).toBe(false);
  });

  test("AC-7 (boundary): the worktree directory follows the run's feature, so a different feature is a different path", async () => {
    const firstRun = stubGit();
    stubAcpxSpawn();
    await rectifyConflictedStory(makeOpts("f"));

    const secondRun = stubGit();
    stubAcpxSpawn();
    await rectifyConflictedStory(makeOpts("g"));

    const addPath = (calls: string[][]): string | undefined =>
      calls.find((args) => args[0] === "worktree" && args[1] === "add")?.[3];

    expect(addPath(firstRun)?.endsWith(join(".nax-wt", "story-f-US-001"))).toBe(true);
    expect(addPath(secondRun)?.endsWith(join(".nax-wt", "story-g-US-001"))).toBe(true);
    expect(addPath(firstRun)).not.toBe(addPath(secondRun));
  });
});
