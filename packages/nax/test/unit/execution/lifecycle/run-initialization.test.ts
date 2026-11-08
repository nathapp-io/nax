/**
 * Unit tests for run-initialization.ts — ENH-007
 *
 * Verifies reconcileState + resetFailedStoriesToPending behavior:
 * - Only review/autofix failures are reconcilable (re-runs review gate → "passed")
 * - All other failure stages (execution, verify, etc.) are NOT reconciled to "passed"
 *   but ARE reset to "pending" for re-run
 * - No failureStage => NOT reconciled to "passed", reset to "pending" for re-run
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeAgentAdapter, makeNaxConfig, makeTempDir, withInfoSpy } from "@test/helpers";
import { resolveDefaultAgent } from "@/agents";
import { DEFAULT_CONFIG } from "@/config";
import { _reconcileDeps, initializeRun } from "@/execution/lifecycle/run-initialization";
import { getLogger, initLogger, resetLogger } from "@/logger";
import type { AgentGetFn } from "@/pipeline/types";
import type { PRD } from "@/prd/types";
import type { ReviewResult } from "@/review/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeReviewSuccess(): ReviewResult {
  return { success: true, checks: [], totalDurationMs: 10 };
}

function makeReviewFailure(reason: string): ReviewResult {
  return { success: false, checks: [], totalDurationMs: 10, failureReason: reason };
}

function makePrd(overrides: Partial<PRD["userStories"][number]> = {}): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [
      {
        id: "US-001",
        title: "Test story",
        description: "desc",
        acceptanceCriteria: [],
        dependencies: [],
        tags: [],
        status: "failed",
        passes: false,
        escalations: [],
        attempts: 1,
        ...overrides,
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = makeTempDir("nax-test-reconcile-");
});
afterEach(() => cleanupTempDir(tmpDir));

async function runReconcile(prd: PRD, suffix = ""): Promise<PRD> {
  const prdPath = join(tmpDir, `prd${suffix}.json`);
  await Bun.write(prdPath, JSON.stringify(prd));
  const { prd: result } = await initializeRun({
    config: DEFAULT_CONFIG,
    prdPath,
    workdir: tmpDir,
    dryRun: true,
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcileState", () => {
  let origHasCommits: typeof _reconcileDeps.hasCommitsForStory;
  let origRunReview: typeof _reconcileDeps.runReview;

  beforeEach(() => {
    origHasCommits = _reconcileDeps.hasCommitsForStory;
    origRunReview = _reconcileDeps.runReview;
  });

  afterEach(() => {
    _reconcileDeps.hasCommitsForStory = origHasCommits;
    _reconcileDeps.runReview = origRunReview;
    mock.restore();
  });

  test("no failureStage + commits => NOT reconciled to passed (unknown failure stage), reset to pending for re-run", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed" }); // no failureStage
    const result = await runReconcile(prd, "-1");

    expect(result.userStories[0].status).toBe("pending");
    expect(_reconcileDeps.runReview).not.toHaveBeenCalled();
  });

  test("failureStage=review + review now passes => reconciles as passed", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "review" });
    const result = await runReconcile(prd, "-2");

    expect(result.userStories[0].status).toBe("passed");
    expect(_reconcileDeps.runReview).toHaveBeenCalledTimes(1);
  });

  test("failureStage=review + review still fails => NOT reconciled to passed, reset to pending for re-run", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewFailure("typecheck failed")));

    const prd = makePrd({ status: "failed", failureStage: "review" });
    const result = await runReconcile(prd, "-3");

    expect(result.userStories[0].status).toBe("pending");
    expect(_reconcileDeps.runReview).toHaveBeenCalledTimes(1);
  });

  test("failureStage=autofix + review now passes => reconciles as passed", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "autofix" });
    const result = await runReconcile(prd, "-4");

    expect(result.userStories[0].status).toBe("passed");
    expect(_reconcileDeps.runReview).toHaveBeenCalledTimes(1);
  });

  test("failureStage=execution + commits => NOT reconciled to passed, reset to pending for re-run", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "execution" });
    const result = await runReconcile(prd, "-5");

    expect(result.userStories[0].status).toBe("pending");
    expect(_reconcileDeps.runReview).not.toHaveBeenCalled();
  });

  test("failureStage=verify + commits => NOT reconciled to passed, reset to pending for re-run", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "verify" });
    const result = await runReconcile(prd, "-8");

    expect(result.userStories[0].status).toBe("pending");
    expect(_reconcileDeps.runReview).not.toHaveBeenCalled();
  });

  test("failureStage=regression + commits => NOT reconciled to passed, reset to pending for re-run", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "regression" });
    const result = await runReconcile(prd, "-9");

    expect(result.userStories[0].status).toBe("pending");
    expect(_reconcileDeps.runReview).not.toHaveBeenCalled();
  });

  test("no commits => NOT reconciled to passed, reset to pending for re-run", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "review" });
    const result = await runReconcile(prd, "-6");

    expect(result.userStories[0].status).toBe("pending");
    expect(_reconcileDeps.runReview).not.toHaveBeenCalled();
  });

  test("failureStage=review + story.workdir set => review runs with joined workdir", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));

    let capturedWorkdir: string | undefined;
    _reconcileDeps.runReview = mock((_, workdir) => {
      capturedWorkdir = workdir;
      return Promise.resolve(makeReviewSuccess());
    });

    const prd = makePrd({ status: "failed", failureStage: "review", workdir: "packages/api" });
    await runReconcile(prd, "-7");

    expect(capturedWorkdir).toBe(join(tmpDir, "packages/api"));
  });

  test("re-run: failed story is reset to pending and attempts are reset to 0", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "execution", attempts: 2 });
    const result = await runReconcile(prd, "-10");

    expect(result.userStories[0].status).toBe("pending");
    expect(result.userStories[0].attempts).toBe(0);
  });

  test("re-run: already-passed story is not touched", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "passed", passes: true, attempts: 1 });
    const result = await runReconcile(prd, "-11");

    expect(result.userStories[0].status).toBe("passed");
    expect(result.userStories[0].passes).toBe(true);
  });

  test("AC-13: resetRefOnRerun false keeps the story's existing storyGitRef", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "execution", storyGitRef: "abc123" });
    const prdPath = join(tmpDir, "prd-keep-ref.json");
    await Bun.write(prdPath, JSON.stringify(prd));

    const config = makeNaxConfig({ review: { semantic: { resetRefOnRerun: false } } });

    const { prd: result } = await initializeRun({ config, prdPath, workdir: tmpDir, dryRun: true });

    expect(result.userStories[0].status).toBe("pending");
    expect(result.userStories[0].storyGitRef).toBe("abc123");
  });

  test("resetMode=initial: escalated story routing is restored to initialModelTier on re-run", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({
      status: "failed",
      failureStage: "execution",
      attempts: 5,
      escalations: [{ fromTier: "fast", toTier: "balanced", reason: "budget", timestamp: new Date().toISOString() }],
      routing: {
        complexity: "complex",
        testStrategy: "test-after",
        reasoning: "x",
        modelTier: "powerful",
        initialModelTier: "fast",
      },
    });

    const prdPath = join(tmpDir, "prd-resetmode-initial.json");
    await Bun.write(prdPath, JSON.stringify(prd));

    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode.escalation,
          resetMode: "initial" as const,
        },
      },
    };

    const { prd: result } = await initializeRun({
      config,
      prdPath,
      workdir: tmpDir,
      dryRun: true,
    });

    const story = result.userStories[0];
    expect(story.status).toBe("pending");
    expect(story.attempts).toBe(0);
    expect(story.routing?.modelTier).toBe("fast");
  });

  test("resetMode=last: escalated story routing is NOT restored — modelTier stays at escalated value", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({
      status: "failed",
      failureStage: "execution",
      attempts: 5,
      escalations: [{ fromTier: "fast", toTier: "balanced", reason: "budget", timestamp: new Date().toISOString() }],
      routing: {
        complexity: "complex",
        testStrategy: "test-after",
        reasoning: "x",
        modelTier: "powerful",
        initialModelTier: "fast",
      },
    });

    const prdPath = join(tmpDir, "prd-resetmode-last.json");
    await Bun.write(prdPath, JSON.stringify(prd));

    const config = {
      ...DEFAULT_CONFIG,
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode.escalation,
          resetMode: "last" as const,
        },
      },
    };

    const { prd: result } = await initializeRun({
      config,
      prdPath,
      workdir: tmpDir,
      dryRun: true,
    });

    const story = result.userStories[0];
    expect(story.status).toBe("pending");
    expect(story.attempts).toBe(0);
    // resetMode=last: modelTier should remain at escalated value "powerful"
    expect(story.routing?.modelTier).toBe("powerful");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent preflight
// ─────────────────────────────────────────────────────────────────────────────

describe("agent preflight", () => {
  // The preflight used to be the first statement in initializeRun, gated only
  // on dryRun — so it ran before the PRD was even loaded and could not tell a
  // run with work to do from one with none. Re-running a feature whose stories
  // were all passed then failed with "Agent is not installed" on a machine
  // without the binary, when the correct answer was "nothing to do".
  //
  // These run with `dryRun: false`, which is the only mode that reaches the
  // check at all. `agentGetFn` stands in for the registry so the assertions are
  // about *whether* the preflight runs, not about the host's PATH.

  /** Records every agent lookup the preflight makes, and answers `installed`. */
  function trackAgentLookup(installed: boolean): { agentGetFn: AgentGetFn; lookedUp: string[] } {
    const lookedUp: string[] = [];
    const agentGetFn: AgentGetFn = (name) => {
      lookedUp.push(name);
      return makeAgentAdapter({ binary: "claude", isInstalled: () => Promise.resolve(installed) });
    };
    return { agentGetFn, lookedUp };
  }

  async function initWith(prd: PRD, agentGetFn: AgentGetFn, suffix: string) {
    const prdPath = join(tmpDir, `prd-preflight-${suffix}.json`);
    await Bun.write(prdPath, JSON.stringify(prd));
    return initializeRun({ config: DEFAULT_CONFIG, prdPath, workdir: tmpDir, dryRun: false, agentGetFn });
  }

  test("AC-1: does not look the agent up when every story is passed", async () => {
    // The regression: no story dispatches and the completion phase calls no
    // agent, so a missing binary must not fail the run.
    const { agentGetFn, lookedUp } = trackAgentLookup(false);
    const prd = makePrd({ status: "passed", passes: true });

    const { prd: result } = await initWith(prd, agentGetFn, "skip");

    expect(result.userStories[0].status).toBe("passed");
    expect(lookedUp).toEqual([]);
  });

  test("AC-2: logs the exact skip message when every story is passed", async () => {
    const { agentGetFn } = trackAgentLookup(false);
    const prd = makePrd({ status: "passed", passes: true });

    await withInfoSpy(async (infoSpy) => {
      await initWith(prd, agentGetFn, "skip-log");

      const messages = infoSpy.mock.calls.map((call) => call[1]);
      expect(messages).toContain("Skipping agent preflight — no story needs work");
      // The skip reason is story state alone; nothing about acceptance remains.
      expect(messages.some((message) => message.includes("acceptance"))).toBe(false);
    });
  });

  test("AC-3: looks the default agent up when a story needs work", async () => {
    // A pending story dispatches, so the missing binary must be reported up
    // front rather than surfacing later from inside the run.
    const { agentGetFn, lookedUp } = trackAgentLookup(false);
    const prd = makePrd({ status: "pending", passes: false });

    await expect(initWith(prd, agentGetFn, "pending")).rejects.toThrow(/not installed or not in PATH/);
    expect(lookedUp).toEqual([resolveDefaultAgent(DEFAULT_CONFIG)]);
  });

  test("an installed agent's launch note is logged as a warning (spec §6.8, D3-k)", async () => {
    resetLogger();
    initLogger({ level: "silent" });
    const warnSpy = spyOn(getLogger(), "warn").mockImplementation(() => {});
    try {
      const prdPath = join(tmpDir, "prd-preflight-note.json");
      await Bun.write(prdPath, JSON.stringify(makePrd({ status: "pending", passes: false })));
      const adapter = {
        ...makeAgentAdapter({ binary: "claude", isInstalled: () => Promise.resolve(true) }),
        launchNote: () => "Only the npx fallback can launch this ACP agent",
      };
      await initializeRun({
        config: DEFAULT_CONFIG,
        prdPath,
        workdir: tmpDir,
        dryRun: false,
        agentGetFn: () => adapter,
      });
      expect(warnSpy.mock.calls.some((call) => String(call[1]).includes("npx"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      resetLogger();
    }
  });
});
