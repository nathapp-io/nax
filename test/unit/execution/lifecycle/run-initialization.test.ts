/**
 * Unit tests for run-initialization.ts — ENH-007
 *
 * Verifies reconcileState + resetFailedStoriesToPending behavior:
 * - Only review/autofix failures are reconcilable (re-runs review gate → "passed")
 * - All other failure stages (execution, verify, etc.) are NOT reconciled to "passed"
 *   but ARE reset to "pending" for re-run
 * - No failureStage => NOT reconciled to "passed", reset to "pending" for re-run
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { _reconcileDeps, initializeRun } from "../../../../src/execution/lifecycle/run-initialization";
import type { PRD } from "../../../../src/prd/types";
import type { ReviewResult } from "../../../../src/review/types";
import { makeTempDir } from "../../../helpers/temp";

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

const tmpDir = makeTempDir("nax-test-reconcile-");

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

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
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

  test("re-run: failed story is reset to pending and attempts count is preserved", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "execution", attempts: 2 });
    const result = await runReconcile(prd, "-10");

    expect(result.userStories[0].status).toBe("pending");
    expect(result.userStories[0].attempts).toBe(2);
  });

  test("re-run: already-passed story is not touched", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "passed", passes: true, attempts: 1 });
    const result = await runReconcile(prd, "-11");

    expect(result.userStories[0].status).toBe("passed");
    expect(result.userStories[0].passes).toBe(true);
  });

  test("worktree mode: calls git branch -D nax/<storyId> for each reset story", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const spawnCalls: string[][] = [];
    _reconcileDeps.spawn = mock((args: unknown) => {
      spawnCalls.push(args as string[]);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as unknown as typeof _reconcileDeps.spawn;

    const prd = makePrd({ status: "failed", failureStage: "execution", storyGitRef: "abc123" });
    const prdPath = join(tmpDir, "prd-worktree.json");
    await Bun.write(prdPath, JSON.stringify(prd));

    const worktreeConfig = {
      ...DEFAULT_CONFIG,
      execution: { ...DEFAULT_CONFIG.execution, storyIsolation: "worktree" as const },
    };

    const { prd: result } = await initializeRun({
      config: worktreeConfig,
      prdPath,
      workdir: tmpDir,
      dryRun: true,
    });

    // Story should be reset to pending
    expect(result.userStories[0].status).toBe("pending");
    // storyGitRef should be cleared in worktree mode
    expect(result.userStories[0].storyGitRef).toBeUndefined();
    // git branch -D should have been called for nax/US-001
    const branchDeleteCalls = spawnCalls.filter(
      (a) => a.includes("branch") && a.includes("-D") && a.includes("nax/US-001"),
    );
    expect(branchDeleteCalls.length).toBe(1);
  });

  test("shared mode: does NOT call git branch -D on re-run", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const spawnCalls: string[][] = [];
    _reconcileDeps.spawn = mock((args: unknown) => {
      spawnCalls.push(args as string[]);
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    }) as unknown as typeof _reconcileDeps.spawn;

    const prd = makePrd({ status: "failed", failureStage: "execution" });
    await runReconcile(prd, "-shared");

    const branchDeleteCalls = spawnCalls.filter(
      (a) => a.includes("branch") && a.includes("-D"),
    );
    expect(branchDeleteCalls.length).toBe(0);
  });
});
