/**
 * Unit tests for the completion stage (US-003)
 *
 * Covers:
 * - AC7: completionStage.execute() calls ctx.reviewerSession.destroy()
 *         when ctx.reviewerSession exists, regardless of story pass or fail
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { _completionDeps, completionStage } from "../../../../src/pipeline/stages/completion";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewerSession } from "../../../../src/review/dialogue";
import type { PRD, UserStory } from "../../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Temp directory for file operations (savePRD writes to disk)
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nax-test-completion-"));
  // savePRD writes to workdir/nax/features/unknown/prd.json when featureDir is not set
  mkdirSync(join(tmpDir, "nax", "features", "unknown"), { recursive: true });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<ReviewerSession> = {}): ReviewerSession {
  return {
    active: true,
    history: [],
    review: mock(async () => ({
      checkResult: { success: true, findings: [] },
      findingReasoning: new Map(),
    })),
    reReview: mock(async () => ({
      checkResult: { success: true, findings: [] },
      findingReasoning: new Map(),
      deltaSummary: "Resolved.",
    })),
    clarify: mock(async () => "response"),
    getVerdict: mock(() => ({
      storyId: "US-001",
      passed: true,
      timestamp: new Date().toISOString(),
      acCount: 0,
      findings: [],
    })),
    destroy: mock(async () => {}),
    ...overrides,
  } as unknown as ReviewerSession;
}

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test description",
    acceptanceCriteria: ["AC1: thing works"],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(stories?: UserStory[]): PRD {
  const storyList = stories ?? [makeStory()];
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: storyList,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const story = makeStory();
  return {
    config: DEFAULT_CONFIG,
    rootConfig: DEFAULT_CONFIG,
    prd: makePRD([story]),
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: tmpDir,
    // featureDir intentionally not set — avoids appendProgress file write
    hooks: {},
    agentResult: { output: "", exitCode: 0, success: true, estimatedCost: 0 },
    ...overrides,
  // biome-ignore lint/suspicious/noExplicitAny: test context
  } as any;
}

const originalCompletionDeps = { ..._completionDeps };

beforeEach(() => {
  // Mock file-writing deps that hit the real file system
  _completionDeps.persistSemanticVerdict = mock(async () => {});
  _completionDeps.checkReviewGate = mock(async () => true);
});

afterAll(() => {
  Object.assign(_completionDeps, originalCompletionDeps);
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: destroy() called when reviewerSession exists
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — ReviewerSession cleanup (AC7)", () => {
  test("calls ctx.reviewerSession.destroy() when session exists", async () => {
    const mockSession = makeSession();
    const ctx = makeCtx({ reviewerSession: mockSession });

    await completionStage.execute(ctx);

    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
  });

  test("calls destroy() even when the story passed successfully", async () => {
    const mockSession = makeSession();
    const ctx = makeCtx({ reviewerSession: mockSession });

    const result = await completionStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
  });

  test("does not throw when ctx.reviewerSession is undefined", async () => {
    // No reviewerSession set — should still complete normally
    const ctx = makeCtx();

    await expect(completionStage.execute(ctx)).resolves.toMatchObject({ action: "continue" });
  });

  test("calls destroy() before stage returns", async () => {
    const destroyCallOrder: string[] = [];
    const mockSession = makeSession({
      destroy: mock(async () => {
        destroyCallOrder.push("destroy");
      }),
    });
    const ctx = makeCtx({ reviewerSession: mockSession });

    const result = await completionStage.execute(ctx);
    destroyCallOrder.push("stage-returned");

    expect(destroyCallOrder[0]).toBe("destroy");
    expect(destroyCallOrder[1]).toBe("stage-returned");
    expect(result.action).toBe("continue");
  });

  test("still completes stage even if destroy() throws", async () => {
    const mockSession = makeSession({
      destroy: mock(async () => {
        throw new Error("destroy failed");
      }),
    });
    const ctx = makeCtx({ reviewerSession: mockSession });

    // Stage should handle destroy() errors gracefully
    const result = await completionStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("calls destroy() exactly once per execution", async () => {
    const mockSession = makeSession();
    const ctx = makeCtx({ reviewerSession: mockSession });

    await completionStage.execute(ctx);

    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("completionStage — existing behavior preserved with no reviewerSession", () => {
  test("marks story as passed when no reviewerSession is present", async () => {
    const ctx = makeCtx();

    const result = await completionStage.execute(ctx);

    expect(result.action).toBe("continue");
    // Story should be marked as passed
    const story = ctx.prd.userStories.find((s) => s.id === "US-001");
    expect(story?.status).toBe("passed");
  });
});
