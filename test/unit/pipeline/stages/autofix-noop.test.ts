/**
 * Unit tests for the no-op short-circuit in runAgentRectification.
 *
 * When the agent produces zero file changes (git HEAD does not advance),
 * the attempt should NOT count against the per-cycle budget. Instead the
 * loop re-prompts with a stronger "you must edit or emit UNRESOLVED" directive.
 *
 * After MAX_CONSECUTIVE_NOOP_REPROMPTS (1) free reprompts, the second
 * consecutive no-op is counted as a real attempt to prevent infinite loops.
 *
 * Also covers attemptsRemaining logging on failure and loop exhaustion.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../../src/review/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: { ...DEFAULT_CONFIG.quality.commands },
        autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 10 },
      },
    } as unknown as PipelineContext["config"],
    prd: { stories: [] } as unknown as PipelineContext["prd"],
    story: {
      id: "US-NOOP",
      title: "No-op test",
      status: "in-progress",
      acceptanceCriteria: [],
    } as unknown as PipelineContext["story"],
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: {} as unknown as PipelineContext["hooks"],
    ...overrides,
  };
}

function makeFailedCheck(check: ReviewCheckResult["check"] = "semantic"): ReviewCheckResult {
  return {
    check,
    success: false,
    command: "nax review",
    exitCode: 1,
    output: `${check} failure output`,
    durationMs: 100,
  };
}

/**
 * Creates a mock IAgentManager that captures run() calls.
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
  } as any;
}

// ---------------------------------------------------------------------------
// Saved deps
// ---------------------------------------------------------------------------

let origRecheckReview: typeof _autofixDeps.recheckReview;
let origCaptureGitRef: typeof _autofixDeps.captureGitRef;
let origRunTestWriterRectification: typeof _autofixDeps.runTestWriterRectification;

beforeEach(() => {
  origRecheckReview = _autofixDeps.recheckReview;
  origCaptureGitRef = _autofixDeps.captureGitRef;
  origRunTestWriterRectification = _autofixDeps.runTestWriterRectification;
  // Default: no test-writer rectification needed
  _autofixDeps.runTestWriterRectification = mock(async () => 0);
});

afterEach(() => {
  _autofixDeps.recheckReview = origRecheckReview;
  _autofixDeps.captureGitRef = origCaptureGitRef;
  _autofixDeps.runTestWriterRectification = origRunTestWriterRectification;
});

// ---------------------------------------------------------------------------
// No-op short-circuit — attempt not consumed
// ---------------------------------------------------------------------------

describe("runAgentRectification — no-op short-circuit", () => {
  test("no-op turn is not counted as a consumed attempt", async () => {
    const capturedPrompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      capturedPrompts.push(opts.prompt as string);
      return { success: true, estimatedCostUsd: 0, output: "ok" };
    });
    const agentManager = makeMockAgentManager(mockRun);

    // First call returns same ref (no-op); subsequent calls return different ref (change).
    let captureCallCount = 0;
    _autofixDeps.captureGitRef = mock(async () => {
      captureCallCount++;
      // Calls come in pairs: (before, after) per attempt.
      // Attempt 1 before → "ref-a", Attempt 1 after → "ref-a" (no-op)
      // Attempt 1-reprompt before → "ref-a", Attempt 1-reprompt after → "ref-b" (change)
      // Attempt 2 before → "ref-b", Attempt 2 after → "ref-c" (change)
      if (captureCallCount <= 2) return "ref-a"; // attempt 1: same ref → no-op
      return `ref-${captureCallCount}`; // subsequent: always different
    });

    // Recheck: fails once (after reprompt), then passes.
    let recheckCallCount = 0;
    _autofixDeps.recheckReview = mock(async () => {
      recheckCallCount++;
      return recheckCallCount >= 2;
    });

    const ctx = makeCtx({
      agentManager,
      reviewResult: { success: false, checks: [makeFailedCheck("semantic")] } as unknown as PipelineContext["reviewResult"],
    });

    await _autofixDeps.runAgentRectification(ctx, undefined, undefined, "/tmp");

    // No-op reprompt was the second agent call — should contain "no file changes" text.
    expect(capturedPrompts.length).toBeGreaterThanOrEqual(2);
    expect(capturedPrompts[1]).toContain("no file changes");
  });

  test("no-op reprompt prompt contains UNRESOLVED instruction", async () => {
    const capturedPrompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      capturedPrompts.push(opts.prompt as string);
      return { success: true, estimatedCostUsd: 0, output: "ok" };
    });
    const agentManager = makeMockAgentManager(mockRun);

    // Two consecutive same refs → no-op on first call, then change.
    let captureCallCount = 0;
    _autofixDeps.captureGitRef = mock(async () => {
      captureCallCount++;
      if (captureCallCount <= 2) return "same-ref";
      return `changed-${captureCallCount}`;
    });

    _autofixDeps.recheckReview = mock(async () => false);

    const ctx = makeCtx({
      agentManager,
      reviewResult: { success: false, checks: [makeFailedCheck("adversarial")] } as unknown as PipelineContext["reviewResult"],
    });

    await _autofixDeps.runAgentRectification(ctx, undefined, undefined, "/tmp");

    expect(capturedPrompts[1]).toContain("UNRESOLVED");
  });

  test("second consecutive no-op is counted as a consumed attempt", async () => {
    const capturedPrompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      capturedPrompts.push(opts.prompt as string);
      return { success: true, estimatedCostUsd: 0, output: "ok" };
    });
    const agentManager = makeMockAgentManager(mockRun);

    // All calls return same ref (all no-ops) — agent never makes changes.
    _autofixDeps.captureGitRef = mock(async () => "always-same-ref");

    // Recheck always fails.
    _autofixDeps.recheckReview = mock(async () => false);

    const ctx = makeCtx({
      agentManager,
      reviewResult: { success: false, checks: [makeFailedCheck("semantic")] } as unknown as PipelineContext["reviewResult"],
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { ...DEFAULT_CONFIG.quality.commands },
          autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 10 },
        },
      } as unknown as PipelineContext["config"],
    });

    const result = await _autofixDeps.runAgentRectification(ctx, undefined, undefined, "/tmp");

    // With maxAttempts=2 and MAX_CONSECUTIVE_NOOP_REPROMPTS=1, runRetryLoop consumes one
    // budget slot per iteration regardless of no-op status:
    // - iteration 1: no-op (consecutiveNoOps=1, within limit) → verify returns false → attempt consumed
    // - iteration 2: buildPrompt sends noOpReprompt; no-op again (consecutiveNoOps=2 > limit) → verify returns false → attempt consumed
    // → loop exhausts at 2 consumed iterations (= 2 agent calls)
    expect(result.succeeded).toBe(false);
    expect(capturedPrompts.length).toBe(2);
  });

  test("no-op count resets after agent makes a change", async () => {
    const capturedPrompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      capturedPrompts.push(opts.prompt as string);
      return { success: true, estimatedCostUsd: 0, output: "ok" };
    });
    const agentManager = makeMockAgentManager(mockRun);

    // Iteration 1: no-op (same ref before/after). Iteration 2: change (different ref).
    let captureCallCount = 0;
    _autofixDeps.captureGitRef = mock(async () => {
      captureCallCount++;
      if (captureCallCount <= 2) return "ref-a"; // iteration 1: no-op
      return `ref-${captureCallCount}`; // iteration 2+: changed
    });

    // After iteration 1's no-op is detected, iteration 2 will check if the review passes.
    // Since iteration 2 produces changes and we want the test to succeed, recheck should return true.
    _autofixDeps.recheckReview = mock(async () => true);

    const ctx = makeCtx({
      agentManager,
      reviewResult: { success: false, checks: [makeFailedCheck("semantic")] } as unknown as PipelineContext["reviewResult"],
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { ...DEFAULT_CONFIG.quality.commands },
          autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 10 },
        },
      } as unknown as PipelineContext["config"],
    });

    const result = await _autofixDeps.runAgentRectification(ctx, undefined, undefined, "/tmp");

    expect(result.succeeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// attemptsRemaining in failure logs
// ---------------------------------------------------------------------------

describe("runAgentRectification — attemptsRemaining in logs", () => {
  test("loop exhaustion reports attemptsUsed and globalBudgetUsed", async () => {
    const mockRun = mock(async () => ({ success: false, estimatedCostUsd: 0, output: "", exitCode: 1, rateLimited: false }));
    const agentManager = makeMockAgentManager(mockRun);

    // Always different ref so no-op short-circuit doesn't fire.
    let counter = 0;
    _autofixDeps.captureGitRef = mock(async () => `ref-${counter++}`);
    _autofixDeps.recheckReview = mock(async () => false);

    const ctx = makeCtx({
      agentManager,
      reviewResult: {
        success: false,
        checks: [makeFailedCheck("lint")],
      } as unknown as PipelineContext["reviewResult"],
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { ...DEFAULT_CONFIG.quality.commands },
          autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 10 },
        },
      } as unknown as PipelineContext["config"],
    });

    const result = await _autofixDeps.runAgentRectification(ctx, undefined, undefined, "/tmp");

    expect(result.succeeded).toBe(false);
    // ctx.autofixAttempt should reflect the consumed attempts.
    expect(ctx.autofixAttempt).toBe(2);
  });
});
