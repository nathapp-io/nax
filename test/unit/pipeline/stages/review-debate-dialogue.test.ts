/**
 * Unit tests for the debate+dialogue combined path in the review stage (US-003)
 *
 * Covers:
 * - G4 guard removal: dialogueEnabled is no longer gated on !reviewDebateEnabled
 * - Debate+dialogue first run: session created and stored; falls through to orchestrator
 * - Debate+dialogue re-review: session NOT used for reReview(); falls through to orchestrator
 * - Pure dialogue path (no debate): session.review() and session.reReview() still used (regression guard)
 * - Pure debate (no dialogue): no session created, orchestrator used
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _reviewDeps, reviewStage } from "../../../../src/pipeline/stages/review";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewerSession } from "../../../../src/review/dialogue";
import type { PRD, UserStory } from "../../../../src/prd";
import { makeMockAgentManager, makeNaxConfig, makeSessionManager } from "../../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals — restored in afterEach
// ─────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: resetting injectable test deps
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
    resolveDebate: mock(async () => ({
      checkResult: { success: true, findings: [] },
      findingReasoning: new Map(),
    })),
    reReviewDebate: mock(async () => ({
      checkResult: { success: true, findings: [] },
      findingReasoning: new Map(),
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

function makeConfig(opts: {
  dialogueEnabled: boolean;
  debateEnabled?: boolean;
  debateReviewEnabled?: boolean;
}) {
  return makeNaxConfig({
    review: {
      enabled: true,
      dialogue: {
        enabled: opts.dialogueEnabled,
        maxDialogueMessages: 20,
        maxClarificationsPerAttempt: 3,
      },
    },
    debate: {
      enabled: opts.debateEnabled ?? false,
      stages: {
        review: {
          enabled: opts.debateReviewEnabled ?? false,
          debaters: [],
          resolver: { type: "majority-fail-closed" },
        },
      },
    },
    interaction: {
      plugin: "cli",
      defaults: { timeout: 30000, fallback: "abort" as const },
      triggers: {},
    },
  });
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

function makeCtx(config: ReturnType<typeof makeNaxConfig>, overrides: Partial<PipelineContext> = {}): PipelineContext {
  const mockAgentManager = makeMockAgentManager({
    run: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCostUsd: 0 })),
    runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCostUsd: 0 })),
    completeAs: mock(async () => ({ output: "", costUsd: 0 })),
    complete: mock(async () => ({ output: "", costUsd: 0 })),
    getAgent: () => undefined,
  });

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
    sessionManager: makeSessionManager(),
    ...overrides,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: reviewOrchestrator is a value export, not a type namespace
let orchestratorOriginal: ((...args: any[]) => any) | undefined;

function makeOrchestratorResult(overrides: Partial<{ success: boolean; pluginFailed: boolean; failureReason: string }> = {}) {
  return {
    success: true,
    pluginFailed: false,
    builtIn: { success: true, checks: [], totalDurationMs: 5 },
    ...overrides,
  };
}

beforeEach(async () => {
  const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
  orchestratorOriginal = reviewOrchestrator.review;
  // biome-ignore lint/suspicious/noExplicitAny: mock return satisfies runtime shape
  reviewOrchestrator.review = mock(async () => makeOrchestratorResult()) as any;
});

afterEach(async () => {
  mock.restore();
  // biome-ignore lint/suspicious/noExplicitAny: resetting injectable test deps
  Object.assign(_reviewDeps as any, savedReviewDeps);
  if (orchestratorOriginal) {
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    reviewOrchestrator.review = orchestratorOriginal as any;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// G4 guard removal: dialogueEnabled no longer gated on !reviewDebateEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe("G4 guard removal — dialogueEnabled is independent of reviewDebateEnabled", () => {
  test("creates a ReviewerSession when both debate and dialogue are enabled", async () => {
    const mockSession = makeSession();
    const createSessionMock = mock(() => mockSession);
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = createSessionMock;

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });

  test("stores the session in ctx.reviewerSession when debate+dialogue both enabled", async () => {
    const mockSession = makeSession();
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = mock(() => mockSession);

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(ctx.reviewerSession).toBe(mockSession);
  });

  test("does NOT create a session when debate is enabled but dialogue is disabled", async () => {
    const createSessionMock = mock(() => makeSession());
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = createSessionMock;

    const config = makeConfig({ dialogueEnabled: false, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(createSessionMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Debate+dialogue first run: session stored, falls through to orchestrator
// ─────────────────────────────────────────────────────────────────────────────

describe("debate+dialogue first run — session stored, falls through to orchestrator", () => {
  test("does NOT call session.review() when both debate and dialogue are enabled", async () => {
    const mockSession = makeSession();
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = mock(() => mockSession);

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(mockSession.review).not.toHaveBeenCalled();
  });

  test("falls through to orchestrator on debate+dialogue first run", async () => {
    const mockSession = makeSession();
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = mock(() => mockSession);

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    // biome-ignore lint/suspicious/noExplicitAny: mock return satisfies runtime shape
    const orchestratorMock = mock(async () => makeOrchestratorResult()) as any;
    reviewOrchestrator.review = orchestratorMock;

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    expect(orchestratorMock).toHaveBeenCalledTimes(1);
  });

  test("reviewerSession is available in ctx when orchestrator is called (for debate wiring)", async () => {
    const mockSession = makeSession();
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = mock(() => mockSession);

    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    // biome-ignore lint/suspicious/noExplicitAny: mock return satisfies runtime shape
    reviewOrchestrator.review = mock(async () => makeOrchestratorResult()) as any;

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config);
    await reviewStage.execute(ctx);

    // The session was stored on ctx before orchestrator ran
    expect(ctx.reviewerSession).toBe(mockSession);
  });

  test("returns continue when debate+dialogue review passes", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = mock(() => makeSession());

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config);
    const result = await reviewStage.execute(ctx);

    expect(result.action).toBe("continue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Debate+dialogue re-review: does NOT call session.reReview(); uses orchestrator
// ─────────────────────────────────────────────────────────────────────────────

describe("debate+dialogue re-review — falls through to orchestrator, not session.reReview()", () => {
  test("does NOT call session.reReview() when both debate and dialogue are enabled on retry", async () => {
    const existingSession = makeSession();
    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config, { reviewerSession: existingSession });

    await reviewStage.execute(ctx);

    expect(existingSession.reReview).not.toHaveBeenCalled();
  });

  test("calls orchestrator when debate+dialogue session exists (re-review path)", async () => {
    const existingSession = makeSession();
    const { reviewOrchestrator } = await import("../../../../src/review/orchestrator");
    // biome-ignore lint/suspicious/noExplicitAny: mock return satisfies runtime shape
    const orchestratorMock = mock(async () => makeOrchestratorResult()) as any;
    reviewOrchestrator.review = orchestratorMock;

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config, { reviewerSession: existingSession });
    await reviewStage.execute(ctx);

    expect(orchestratorMock).toHaveBeenCalledTimes(1);
  });

  test("preserves the existing session in ctx for orchestrator to use (re-review)", async () => {
    const existingSession = makeSession();
    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config, { reviewerSession: existingSession });

    await reviewStage.execute(ctx);

    expect(ctx.reviewerSession).toBe(existingSession);
  });

  test("does NOT create a new session on re-review (debate+dialogue)", async () => {
    const existingSession = makeSession();
    const createSessionMock = mock(() => makeSession());
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = createSessionMock;

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: true, debateReviewEnabled: true });
    const ctx = makeCtx(config, { reviewerSession: existingSession });
    await reviewStage.execute(ctx);

    expect(createSessionMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: pure dialogue (no debate) still uses session.review() / reReview()
// ─────────────────────────────────────────────────────────────────────────────

describe("regression — pure dialogue (no debate) path unchanged", () => {
  test("calls session.review() on first run when only dialogue is enabled (no debate)", async () => {
    const mockSession = makeSession();
    // biome-ignore lint/suspicious/noExplicitAny: injectable test dep
    (_reviewDeps as any).createReviewerSession = mock(() => mockSession);

    const config = makeConfig({ dialogueEnabled: true, debateEnabled: false });
    const ctx = makeCtx(config);
    // Add semanticConfig so the session.review() path is triggered
    (ctx.config as unknown as Record<string, unknown>).review = {
      ...(ctx.config.review as object),
      semantic: { model: "balanced", rules: [], timeoutMs: 60000, excludePatterns: [] },
    };
    // Provide a fake agent so the session path isn't skipped
    ctx.agentGetFn = mock(() => ({ complete: mock(async () => ({})) })) as unknown as typeof ctx.agentGetFn;
    (ctx.rootConfig as unknown as Record<string, unknown>).autoMode = { defaultAgent: "claude" };

    await reviewStage.execute(ctx);

    // session.review() should have been called (pure dialogue path)
    expect(mockSession.review).toHaveBeenCalledTimes(1);
  });

  test("calls session.reReview() on retry when only dialogue is enabled (no debate)", async () => {
    const existingSession = makeSession();
    const config = makeConfig({ dialogueEnabled: true, debateEnabled: false });
    const ctx = makeCtx(config, { reviewerSession: existingSession });

    await reviewStage.execute(ctx);

    expect(existingSession.reReview).toHaveBeenCalledTimes(1);
  });
});
