/**
 * Unit tests for run-initialization.ts — ENH-007
 *
 * Verifies reconcileState behavior:
 * - Only review/autofix failures are reconcilable (re-runs review gate)
 * - All other failure stages (execution, verify, etc.) are NOT reconciled
 * - No failureStage => NOT reconciled (unknown failure = not safe)
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

  test("no failureStage + commits => NOT reconciled (unknown failure stage)", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed" }); // no failureStage
    const result = await runReconcile(prd, "-1");

    expect(result.userStories[0].status).toBe("failed");
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

  test("failureStage=review + review still fails => NOT reconciled", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewFailure("typecheck failed")));

    const prd = makePrd({ status: "failed", failureStage: "review" });
    const result = await runReconcile(prd, "-3");

    expect(result.userStories[0].status).toBe("failed");
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

  test("failureStage=execution + commits => NOT reconciled", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "execution" });
    const result = await runReconcile(prd, "-5");

    expect(result.userStories[0].status).toBe("failed");
    expect(_reconcileDeps.runReview).not.toHaveBeenCalled();
  });

  test("failureStage=verify + commits => NOT reconciled", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "verify" });
    const result = await runReconcile(prd, "-8");

    expect(result.userStories[0].status).toBe("failed");
    expect(_reconcileDeps.runReview).not.toHaveBeenCalled();
  });

  test("failureStage=regression + commits => NOT reconciled", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(true));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "regression" });
    const result = await runReconcile(prd, "-9");

    expect(result.userStories[0].status).toBe("failed");
    expect(_reconcileDeps.runReview).not.toHaveBeenCalled();
  });

  test("no commits => NOT reconciled (existing behavior)", async () => {
    _reconcileDeps.hasCommitsForStory = mock(() => Promise.resolve(false));
    _reconcileDeps.runReview = mock(() => Promise.resolve(makeReviewSuccess()));

    const prd = makePrd({ status: "failed", failureStage: "review" });
    const result = await runReconcile(prd, "-6");

    expect(result.userStories[0].status).toBe("failed");
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
});
