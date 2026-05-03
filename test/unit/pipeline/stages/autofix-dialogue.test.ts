/**
 * Unit tests for CLARIFY relay and clarification cap in the autofix stage (US-003)
 *
 * Covers:
 * - AC5: Detects CLARIFY: blocks in agent output and relays to reviewerSession.clarify()
 * - AC6: Clarification round-trips are capped at maxClarificationsPerAttempt
 * - AC10: When ReviewerSession.clarify() throws, proceeds without clarification (debug log)
 *
 * These tests go through the REAL runAgentRectification (not mocked) to verify
 * CLARIFY detection behavior is wired in the live code path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _autofixDeps, autofixStage } from "../../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import type { ReviewerSession } from "../../../../src/review/dialogue";
import type { ReviewCheckResult } from "../../../../src/review/types";
import { makeMockRuntime } from "../../../helpers/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFailedReviewResult(checks: Partial<ReviewCheckResult>[]) {
  const fullChecks = checks.map((c) => ({
    check: c.check ?? "semantic",
    success: false,
    command: c.command ?? "semantic-review",
    exitCode: c.exitCode ?? 1,
    output: c.output ?? "AC not implemented",
    durationMs: c.durationMs ?? 100,
  }));
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  return { success: false, checks: fullChecks, summary: "" } as any;
}

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
    clarify: mock(async () => "Here is the clarification"),
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

function makeDialogueConfig(
  dialogueEnabled: boolean,
  overrides: { maxClarificationsPerAttempt?: number } = {},
) {
  return {
    ...DEFAULT_CONFIG,
    review: {
      ...DEFAULT_CONFIG.review,
      dialogue: {
        enabled: dialogueEnabled,
        maxDialogueMessages: 20,
        maxClarificationsPerAttempt: overrides.maxClarificationsPerAttempt ?? 3,
      },
    },
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: {
        ...DEFAULT_CONFIG.quality.commands,
        test: "bun test",
        // no lintFix/formatFix — force agent path
      },
      autofix: { enabled: true, maxAttempts: 2 },
    },
    autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
  // biome-ignore lint/suspicious/noExplicitAny: test config
  } as any;
}

/**
 * Creates a mock IAgentManager that forwards run() to a mock agent.
 * AgentManager.run() extracts request.runOptions and passes them to adapter.run(),
 * so the mock extracts runOptions and forwards them to the inner mock.
 */
function makeMockAgentManager(mockRun: ReturnType<typeof mock>) {
  return {
    getDefault: () => "claude",
    run: mock(async (request: { runOptions: Record<string, unknown> }) => {
      return await mockRun(request.runOptions);
    }),
    runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCostUsd: 0 })),
    completeAs: mock(async () => ({ output: "", costUsd: 0 })),
    complete: mock(async () => ({ output: "", costUsd: 0 })),
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} },
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: mock(async (request: { runOptions: Record<string, unknown> }) => {
      return { result: await mockRun(request.runOptions), fallbacks: [] };
    }),
    completeWithFallback: mock(async () => ({ result: { output: "", costUsd: 0 }, fallbacks: [] })),
    getAgent: () => undefined,
    runAsSession: mock(async (_agentName: string, _handle: unknown, prompt: string, _options: unknown) => {
      const result = await mockRun({ prompt });
      return {
        output: result.output ?? "",
        estimatedCostUsd: result.estimatedCostUsd ?? 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      };
    }),
  } as any;
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const runtime = makeMockRuntime({});
  return {
    config: makeDialogueConfig(true),
    rootConfig: makeDialogueConfig(true),
    prd: { feature: "my-feature", userStories: [] } as PRD,
    story: {
      id: "US-001",
      title: "Test Story",
      description: "",
      acceptanceCriteria: ["AC1: thing works"],
      tags: [],
      dependencies: [],
      status: "in-progress",
      passes: false,
      escalations: [],
      attempts: 1,
    } as UserStory,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp",
    hooks: {},
    runtime,
    ...overrides,
  // biome-ignore lint/suspicious/noExplicitAny: test context
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps
// ─────────────────────────────────────────────────────────────────────────────

let origRecheckReview: typeof _autofixDeps.recheckReview;
let origCaptureGitRef: typeof _autofixDeps.captureGitRef;
let origHasWorkingTreeChange: typeof _autofixDeps.hasWorkingTreeChange;

beforeEach(() => {
  origRecheckReview = _autofixDeps.recheckReview;
  origCaptureGitRef = _autofixDeps.captureGitRef;
  origHasWorkingTreeChange = _autofixDeps.hasWorkingTreeChange;
  _autofixDeps.hasWorkingTreeChange = mock(async () => true);
});

afterEach(() => {
  _autofixDeps.recheckReview = origRecheckReview;
  _autofixDeps.captureGitRef = origCaptureGitRef;
  _autofixDeps.hasWorkingTreeChange = origHasWorkingTreeChange;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: CLARIFY relay to reviewerSession.clarify()
// ─────────────────────────────────────────────────────────────────────────────

describe("autofixStage — CLARIFY relay (AC5)", () => {
  test("calls ctx.reviewerSession.clarify() when agent output matches /^CLARIFY:\\s*(.+)$/ms", async () => {
    const mockSession = makeSession();

    let agentCallCount = 0;
    const mockRun = mock(async (_opts: Record<string, unknown>) => {
      agentCallCount++;
      if (agentCallCount === 1) {
        // First attempt: contains CLARIFY block
        return {
          output: "CLARIFY: What does AC1 mean exactly?\nWill fix once clarified.",
          success: false,
          estimatedCostUsd: 0,
        };
      }
      // Subsequent: no CLARIFY
      return { output: "Fixed the issue.", success: true, estimatedCostUsd: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    _autofixDeps.recheckReview = mock(async () => agentCallCount >= 2);
    _autofixDeps.captureGitRef = mock(async () => `ref-${agentCallCount}`);

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic", output: "AC not implemented" }]),
      reviewerSession: mockSession,
    });

    await autofixStage.execute(ctx);

    expect(mockSession.clarify).toHaveBeenCalledTimes(1);
    expect((mockSession.clarify as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain("What does AC1 mean exactly?");
  });

  test("extracts question correctly from multi-line CLARIFY block", async () => {
    const mockSession = makeSession();

    const mockRun = mock(async (_opts: Record<string, unknown>) => ({
      output: "Some intro text.\nCLARIFY: Should I modify auth.ts or service.ts?\nMore content.",
      success: false,
      estimatedCostUsd: 0,
    }));
    const agentManager = makeMockAgentManager(mockRun);
    _autofixDeps.recheckReview = mock(async () => false);
    _autofixDeps.captureGitRef = mock(async () => "ref-always-same");

    const config = makeDialogueConfig(true);
    config.quality.autofix.maxAttempts = 1;

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic" }]),
      reviewerSession: mockSession,
      config,
      rootConfig: config,
    });

    await autofixStage.execute(ctx);

    expect(mockSession.clarify).toHaveBeenCalled();
    const calledWith = (mockSession.clarify as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    expect(calledWith).toContain("Should I modify auth.ts or service.ts?");
  });

  test("does not call clarify() when agent output has no CLARIFY block", async () => {
    const mockSession = makeSession();

    const mockRun = mock(async (_opts: Record<string, unknown>) => ({
      output: "I fixed the issue by updating the handler.",
      success: true,
      estimatedCostUsd: 0,
    }));
    const agentManager = makeMockAgentManager(mockRun);
    _autofixDeps.recheckReview = mock(async () => true);
    _autofixDeps.captureGitRef = mock(async () => "ref-changed");

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic" }]),
      reviewerSession: mockSession,
    });

    await autofixStage.execute(ctx);

    expect(mockSession.clarify).not.toHaveBeenCalled();
  });

  test("does not call clarify() when ctx.reviewerSession is undefined", async () => {
    const mockRun = mock(async (_opts: Record<string, unknown>) => ({
      output: "CLARIFY: What should I do?\nProceeding.",
      success: true,
      estimatedCostUsd: 0,
    }));
    const agentManager = makeMockAgentManager(mockRun);
    _autofixDeps.recheckReview = mock(async () => true);
    let captureCallCount = 0;
    _autofixDeps.captureGitRef = mock(async () => {
      captureCallCount++;
      return captureCallCount === 1 ? "ref-before" : "ref-after";
    });

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic" }]),
      // no reviewerSession
    });

    // Should not throw even without a session
    const result = await autofixStage.execute(ctx);

    expect(result.action).toBe("retry");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: Clarification cap at maxClarificationsPerAttempt
// ─────────────────────────────────────────────────────────────────────────────

describe("autofixStage — clarification cap (AC6)", () => {
  test("caps clarification calls at maxClarificationsPerAttempt per attempt", async () => {
    let clarifyCallCount = 0;
    const mockSession = makeSession({
      clarify: mock(async () => {
        clarifyCallCount++;
        return "Here is the answer";
      }),
    });

    const maxClarifications = 2;
    const config = makeDialogueConfig(true, { maxClarificationsPerAttempt: maxClarifications });
    config.quality.autofix.maxAttempts = 1;

    // Agent always returns CLARIFY — without a cap this would loop indefinitely
    const mockRun = mock(async (_opts: Record<string, unknown>) => ({
      // Multiple CLARIFY blocks — but only first maxClarifications should be processed
      output:
        "CLARIFY: Question 1?\nCLARIFY: Question 2?\nCLARIFY: Question 3?\nCLARIFY: Question 4?\nDone.",
      success: false,
      estimatedCostUsd: 0,
    }));
    const agentManager = makeMockAgentManager(mockRun);
    _autofixDeps.recheckReview = mock(async () => false);
    _autofixDeps.captureGitRef = mock(async () => "ref-always-same");

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic" }]),
      reviewerSession: mockSession,
      config,
      rootConfig: config,
    });

    await autofixStage.execute(ctx);

    expect(clarifyCallCount).toBeLessThanOrEqual(maxClarifications);
  });

  test("excess clarification requests are silently skipped (no error thrown)", async () => {
    const mockSession = makeSession();

    const config = makeDialogueConfig(true, { maxClarificationsPerAttempt: 1 });
    config.quality.autofix.maxAttempts = 1;

    const mockRun = mock(async (_opts: Record<string, unknown>) => ({
      output: "CLARIFY: Q1?\nCLARIFY: Q2?\nCLARIFY: Q3?\nFixed.",
      success: true,
      estimatedCostUsd: 0,
    }));
    const agentManager = makeMockAgentManager(mockRun);
    _autofixDeps.recheckReview = mock(async () => true);
    _autofixDeps.captureGitRef = mock(async () => "ref-changed");

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic" }]),
      reviewerSession: mockSession,
      config,
      rootConfig: config,
    });

    // Must not throw
    await expect(autofixStage.execute(ctx)).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: Proceeds without clarification when reviewerSession.clarify() throws
// ─────────────────────────────────────────────────────────────────────────────

describe("autofixStage — clarify() error resilience (AC10)", () => {
  test("proceeds without clarification when ReviewerSession.clarify() throws", async () => {
    const mockSession = makeSession({
      clarify: mock(async () => {
        throw new Error("ACP clarify failed");
      }),
    });

    const mockRun = mock(async (_opts: Record<string, unknown>) => ({
      output: "CLARIFY: What is AC1?\nFixed the issue anyway.",
      success: true,
      estimatedCostUsd: 0,
    }));
    const agentManager = makeMockAgentManager(mockRun);
    _autofixDeps.recheckReview = mock(async () => true);
    let captureCallCount = 0;
    _autofixDeps.captureGitRef = mock(async () => {
      captureCallCount++;
      return captureCallCount === 1 ? "ref-before" : "ref-after";
    });

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic" }]),
      reviewerSession: mockSession,
    });

    // Must not throw even when clarify() throws
    const result = await autofixStage.execute(ctx);

    // Stage should still complete successfully (clarify failure is non-fatal)
    expect(result.action).toBe("retry");
  });

  test("autofixStage returns a valid result when clarify() throws on every call", async () => {
    const mockSession = makeSession({
      clarify: mock(async () => {
        throw new Error("Always fails");
      }),
    });

    let agentCallCount = 0;
    const mockRun = mock(async (_opts: Record<string, unknown>) => {
      agentCallCount++;
      return { output: "CLARIFY: Question?\nAttempting fix.", success: true, estimatedCostUsd: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    _autofixDeps.recheckReview = mock(async () => agentCallCount >= 1);
    _autofixDeps.captureGitRef = mock(async () => "ref-changed");

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic" }]),
      reviewerSession: mockSession,
    });

    const result = await autofixStage.execute(ctx);

    expect(result.action).toMatch(/^(retry|escalate)$/);
  });
});
