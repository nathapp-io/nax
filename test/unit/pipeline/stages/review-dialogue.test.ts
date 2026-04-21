/**
 * Unit tests for ReviewerSession integration in the review stage (US-003)
 *
 * Covers:
 * - AC1: PipelineContext type includes reviewerSession field
 * - AC2: Creates ReviewerSession via createReviewerSession() when dialogue.enabled is true
 * - AC3: Calls ctx.reviewerSession.reReview() on retry instead of full orchestrator review
 * - AC8: No session created when dialogue.enabled is false
 * - AC9: Falls back to one-shot and logs warn when ReviewerSession.review() throws
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { _reviewDeps, reviewStage } from "../../../../src/pipeline/stages/review";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { makeMockAgentManager } from "../../../helpers";
import type { ReviewerSession } from "../../../../src/review/dialogue";
import type { PRD, UserStory } from "../../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals — restored in afterEach
// ─────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: _reviewDeps does not have createReviewerSession yet (red phase)
const savedReviewDeps = { ...(_reviewDeps as any) };

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
      deltaSummary: "All resolved.",
    })),
    clarify: mock(async () => "clarification response"),
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

function makeConfig(dialogueEnabled: boolean, dialogueOverrides?: Record<string, unknown>): NaxConfig {
  return {
    review: {
      enabled: true,
      dialogue: {
        enabled: dialogueEnabled,
        maxDialogueMessages: 20,
        maxClarificationsPerAttempt: 3,
        ...dialogueOverrides,
      },
    },
    interaction: {
      plugin: "cli",
      defaults: { timeout: 30000, fallback: "abort" as const },
      triggers: {},
    },
  } as unknown as NaxConfig;
}

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test",
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

function makePRD(): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory()],
  };
}

function makeCtx(config: NaxConfig, overrides: Partial<PipelineContext> = {}): PipelineContext {
  const mockAgentManager = makeMockAgentManager();

  return {
    config,
    rootConfig: config,
    prd: makePRD(),
    story: makeStory(),
    stories: [makeStory()],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp/test",
    hooks: {} as PipelineContext["hooks"],
    agentManager: mockAgentManager,
    ...overrides,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

let orchestratorOriginal: import("../../../../src/review/orchestrator").reviewOrchestrator["review"] | undefined;

beforeEach(async () => {
  const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
  orchestratorOriginal = reviewOrchestrator.review;
  reviewOrchestrator.review = mock(async () => ({
    success: true,
    pluginFailed: false,
    builtIn: { totalDurationMs: 5 },
  })) as typeof reviewOrchestrator.review;
});

afterEach(async () => {
  mock.restore();
  // Restore _reviewDeps to original state
  // biome-ignore lint/suspicious/noExplicitAny: resetting injectable test deps
  Object.assign(_reviewDeps as any, savedReviewDeps);
  if (orchestratorOriginal) {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    reviewOrchestrator.review = orchestratorOriginal;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: PipelineContext type includes optional reviewerSession field
// ─────────────────────────────────────────────────────────────────────────────

describe("PipelineContext — reviewerSession type field (AC1)", () => {
  test("PipelineContext accepts an optional reviewerSession field typed as ReviewerSession", () => {
    // TypeScript compile-time check: if PipelineContext doesn't declare reviewerSession,
    // the assignment below will fail bun run typecheck.
    const ctx = {} as Partial<PipelineContext>;
    const _session: ReviewerSession | undefined = ctx.reviewerSession;

    // Runtime check: undefined is a valid initial value
    expect(_session).toBeUndefined();
  });

  test("reviewerSession field is assignable on a PipelineContext object", () => {
    const mockSession = makeSession();
    const ctx = makeCtx(makeConfig(false));

    // This should compile without error once the type is declared
    ctx.reviewerSession = mockSession;
    expect(ctx.reviewerSession).toBe(mockSession);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: Creates ReviewerSession when dialogue.enabled is true
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — dialogue session creation (AC2)", () => {
  test("calls createReviewerSession() when ctx.config.review.dialogue.enabled is true", async () => {
    const mockSession = makeSession();
    const createSessionMock = mock(() => mockSession);
    // biome-ignore lint/suspicious/noExplicitAny: _reviewDeps.createReviewerSession does not exist yet
    (_reviewDeps as any).createReviewerSession = createSessionMock;

    const config = makeConfig(true);
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });

  test("stores the created ReviewerSession in ctx.reviewerSession", async () => {
    const mockSession = makeSession();
    // biome-ignore lint/suspicious/noExplicitAny: _reviewDeps.createReviewerSession does not exist yet
    (_reviewDeps as any).createReviewerSession = mock(() => mockSession);

    const config = makeConfig(true);
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(ctx.reviewerSession).toBe(mockSession);
  });

  test("passes storyId to createReviewerSession()", async () => {
    const mockSession = makeSession();
    const createSessionMock = mock(() => mockSession);
    // biome-ignore lint/suspicious/noExplicitAny: _reviewDeps.createReviewerSession does not exist yet
    (_reviewDeps as any).createReviewerSession = createSessionMock;

    const config = makeConfig(true);
    const story = makeStory({ id: "US-042" });
    const ctx = makeCtx(config, { story });
    await reviewStage.execute(ctx);

    // First argument should include storyId
    const callArgs = createSessionMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    // storyId should appear somewhere in the call args
    const argsStr = JSON.stringify(callArgs);
    expect(argsStr).toContain("US-042");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: Calls ctx.reviewerSession.reReview() on retry instead of full review
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — reReview on retry (AC3)", () => {
  test("calls ctx.reviewerSession.reReview() when session already exists in ctx", async () => {
    const mockSession = makeSession();
    const config = makeConfig(true);
    const ctx = makeCtx(config, { reviewerSession: mockSession });

    await reviewStage.execute(ctx);

    expect(mockSession.reReview).toHaveBeenCalledTimes(1);
  });

  test("does not create a new ReviewerSession when ctx.reviewerSession already exists", async () => {
    const existingSession = makeSession();
    const createSessionMock = mock(() => makeSession());
    // biome-ignore lint/suspicious/noExplicitAny: _reviewDeps.createReviewerSession does not exist yet
    (_reviewDeps as any).createReviewerSession = createSessionMock;

    const config = makeConfig(true);
    const ctx = makeCtx(config, { reviewerSession: existingSession });
    await reviewStage.execute(ctx);

    expect(createSessionMock).not.toHaveBeenCalled();
  });

  test("preserves the existing session reference in ctx.reviewerSession after reReview", async () => {
    const existingSession = makeSession();
    const config = makeConfig(true);
    const ctx = makeCtx(config, { reviewerSession: existingSession });

    await reviewStage.execute(ctx);

    expect(ctx.reviewerSession).toBe(existingSession);
  });

  test("returns continue when reReview() result shows all findings resolved", async () => {
    const mockSession = makeSession({
      reReview: mock(async () => ({
        checkResult: { success: true, findings: [] },
        findingReasoning: new Map(),
        deltaSummary: "All resolved.",
      })),
    });
    const config = makeConfig(true);
    const ctx = makeCtx(config, { reviewerSession: mockSession });

    const result = await reviewStage.execute(ctx);
    expect(result.action).toBe("continue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: No session created when dialogue.enabled is false
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — no session when dialogue disabled (AC8)", () => {
  test("does not call createReviewerSession() when dialogue.enabled is false", async () => {
    const createSessionMock = mock(() => makeSession());
    // biome-ignore lint/suspicious/noExplicitAny: _reviewDeps.createReviewerSession does not exist yet
    (_reviewDeps as any).createReviewerSession = createSessionMock;

    const config = makeConfig(false);
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(createSessionMock).not.toHaveBeenCalled();
  });

  test("ctx.reviewerSession remains undefined when dialogue.enabled is false", async () => {
    const config = makeConfig(false);
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(ctx.reviewerSession).toBeUndefined();
  });

  test("uses the one-shot orchestrator path when dialogue.enabled is false", async () => {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const orchestratorMock = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: { totalDurationMs: 5 },
    }));
    reviewOrchestrator.review = orchestratorMock as typeof reviewOrchestrator.review;

    const config = makeConfig(false);
    const ctx = makeCtx(config);
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(orchestratorMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: Falls back to one-shot runSemanticReview() when ReviewerSession.review() throws
// ─────────────────────────────────────────────────────────────────────────────

describe("reviewStage — fallback on ReviewerSession.review() failure (AC9)", () => {
  test("falls back to orchestrator one-shot review when ReviewerSession.review() throws", async () => {
    const failingSession = makeSession({
      review: mock(async () => {
        throw new Error("ACP session failed");
      }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: _reviewDeps.createReviewerSession does not exist yet
    (_reviewDeps as any).createReviewerSession = mock(() => failingSession);

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    const orchestratorMock = mock(async () => ({
      success: true,
      pluginFailed: false,
      builtIn: { totalDurationMs: 5 },
    }));
    reviewOrchestrator.review = orchestratorMock as typeof reviewOrchestrator.review;

    const config = makeConfig(true);
    const ctx = makeCtx(config);
    const result = await reviewStage.execute(ctx);

    // Stage must still complete normally (fallback succeeded)
    expect(result.action).toBe("continue");
    // The orchestrator fallback was used
    expect(orchestratorMock).toHaveBeenCalled();
  });

  test("does not propagate the ReviewerSession error to the caller", async () => {
    const failingSession = makeSession({
      review: mock(async () => {
        throw new Error("Session timeout");
      }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: _reviewDeps.createReviewerSession does not exist yet
    (_reviewDeps as any).createReviewerSession = mock(() => failingSession);

    const config = makeConfig(true);
    const ctx = makeCtx(config);

    // execute() must not throw — the error is handled internally
    await expect(reviewStage.execute(ctx)).resolves.toBeDefined();
  });

  test("ReviewerSession failure falls back to one-shot and result is still valid", async () => {
    const failingSession = makeSession({
      review: mock(async () => {
        throw new Error("Connection lost");
      }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: _reviewDeps.createReviewerSession does not exist yet
    (_reviewDeps as any).createReviewerSession = mock(() => failingSession);

    // Orchestrator returns a failing review (so autofix can handle)
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    reviewOrchestrator.review = mock(async () => ({
      success: false,
      pluginFailed: false,
      failureReason: "lint failed",
      builtIn: { totalDurationMs: 5 },
    })) as typeof reviewOrchestrator.review;

    const config = makeConfig(true);
    const ctx = makeCtx(config);
    const result = await reviewStage.execute(ctx);

    // Built-in check failure returns continue (for autofix)
    expect(result.action).toBe("continue");
    // ctx.reviewResult should be set from the one-shot fallback
    expect(ctx.reviewResult).toBeDefined();
  });
});
