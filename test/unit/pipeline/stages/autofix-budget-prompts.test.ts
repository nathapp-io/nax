// RE-ARCH: keep
import { describe, expect, mock, test } from "bun:test";
import { _autofixDeps, autofixStage } from "../../../../src/pipeline/stages/autofix";
import { RectifierPromptBuilder } from "../../../../src/prompts";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { ReviewCheckResult } from "../../../../src/review/types";

function makeFailedReviewResult(checks: Partial<ReviewCheckResult>[]) {
  const fullChecks = checks.map((c) => ({
    check: c.check ?? "lint",
    success: false,
    command: c.command ?? "biome check",
    exitCode: c.exitCode ?? 1,
    output: c.output ?? "error output",
    durationMs: c.durationMs ?? 100,
  }));
  return { success: false, checks: fullChecks, summary: "" } as any;
}

/**
 * Creates a mock IAgentManager that captures run() calls.
 * Extracts runOptions from each AgentRunRequest and forwards to the inner mock.
 */
function makeMockAgentManager(mockRun: ReturnType<typeof mock>) {
  return {
    getDefault: () => "claude",
    run: mock(async (request: { runOptions: Record<string, unknown> }) => {
      return await mockRun(request.runOptions);
    }),
    runAs: mock(async () => ({ success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 10, estimatedCost: 0 })),
    completeAs: mock(async () => ({ output: "", costUsd: 0 })),
    complete: mock(async () => ({ output: "", costUsd: 0 })),
    planAs: mock(async () => ({ specContent: "" })),
    decomposeAs: mock(async () => ({ stories: [] })),
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

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        commands: {
          ...DEFAULT_CONFIG.quality.commands,
          lintFix: "biome check --fix",
          formatFix: "biome format --write",
        },
        autofix: { enabled: true, maxAttempts: 2 },
      },
    } as any,
    prd: { stories: [] } as any,
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp",
    projectDir: "/tmp",
    hooks: { hooks: {} } as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// #106: Global autofix budget — ctx.autofixAttempt persists across cycles
// ---------------------------------------------------------------------------

describe("autofixStage — global budget (#106)", () => {
  test("ctx.autofixAttempt persists across cycles", async () => {
    let agentSpawnCount = 0;
    const mockRun = mock(async () => {
      agentSpawnCount++;
      return { success: false, estimatedCost: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "TS error" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 5 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    // Cycle 1: should use 2 attempts (total: 2)
    await autofixStage.execute(ctx);
    expect(ctx.autofixAttempt).toBe(2);
    expect(agentSpawnCount).toBe(2);

    // Cycle 2: reset review failure, call again — should use 2 more (total: 4)
    ctx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "TS error" }]);
    await autofixStage.execute(ctx);
    expect(ctx.autofixAttempt).toBe(4);
    expect(agentSpawnCount).toBe(4);

    // Cycle 3: only 1 remaining in budget (5 - 4 = 1)
    ctx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "TS error" }]);
    await autofixStage.execute(ctx);
    expect(ctx.autofixAttempt).toBe(5);
    expect(agentSpawnCount).toBe(5);

    // Cycle 4: budget exhausted — no more spawns
    ctx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "TS error" }]);
    await autofixStage.execute(ctx);
    expect(ctx.autofixAttempt).toBe(5);
    expect(agentSpawnCount).toBe(5);

    _autofixDeps.recheckReview = saved.recheckReview;
  });
});

// ---------------------------------------------------------------------------
// Prompt escalation: rethink and urgency injection
// ---------------------------------------------------------------------------

describe("autofixStage — prompt escalation", () => {
  test("injects rethink prompt on configured autofix attempt", async () => {
    const prompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      prompts.push(opts.prompt as string);
      return { success: false, estimatedCost: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "TS error" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 2, rethinkAtAttempt: 2 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);

    _autofixDeps.recheckReview = saved.recheckReview;

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Rethink your approach");
    expect(prompts[1]).toContain("Rethink your approach");
    expect(prompts[1]).toContain("URGENT");
  });

  test("injects urgency and rethink when urgencyAtAttempt is reached", async () => {
    const prompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      prompts.push(opts.prompt as string);
      return { success: false, estimatedCost: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "TS error" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 2, rethinkAtAttempt: 2, urgencyAtAttempt: 2 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);

    _autofixDeps.recheckReview = saved.recheckReview;

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Rethink your approach");
    expect(prompts[1]).toContain("Rethink your approach");
    expect(prompts[1]).toContain("URGENT");
  });

  test("uses default rethink and urgency thresholds when autofix escalation config is not set", async () => {
    const prompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      prompts.push(opts.prompt as string);
      return { success: false, estimatedCost: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "TS error" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 2 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);

    _autofixDeps.recheckReview = saved.recheckReview;

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Rethink your approach");
    expect(prompts[0]).not.toContain("Final Autofix Attempt Before Escalation");
    expect(prompts[1]).toContain("Rethink your approach");
    expect(prompts[1]).toContain("URGENT");
  });
});

// ---------------------------------------------------------------------------
// #412: buildPrompt behavior tests
// ---------------------------------------------------------------------------

describe("autofixStage — #412 prompt selection", () => {
  test("#412: attempt===1 && sessionConfirmedOpen===true uses firstAttemptDelta (not full prompt, not continuation)", async () => {
    const prompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      prompts.push(opts.prompt as string);
      return { success: false, estimatedCost: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "TS type error" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 1 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);

    _autofixDeps.recheckReview = saved.recheckReview;

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("TS type error");
    expect(prompts[0]).toContain("Review failed after your implementation");
    expect(prompts[0].toLowerCase()).not.toContain("acceptance criteria");
    expect(prompts[0]).not.toMatch(/^Story:/m);
    expect(prompts[0]).not.toContain("Your previous fix attempt did not resolve all issues");
  });

  test("#412: attempt===1 && sessionConfirmedOpen===false uses full prompt", async () => {
    const errorText = "Unused variable at line 42";
    const failedChecks: ReviewCheckResult[] = [
      {
        check: "lint",
        success: false,
        command: "biome check",
        exitCode: 1,
        output: errorText,
        durationMs: 50,
      },
    ];
    const story = { id: "US-412", title: "My story", acceptanceCriteria: [] } as any;

    const prompt = RectifierPromptBuilder.reviewRectification(failedChecks, story);

    expect(prompt).toContain("US-412");
    expect(prompt).toContain(errorText);
  });

  test("#412: attempt===2 && sessionConfirmedOpen===true uses continuation prompt", async () => {
    const prompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      prompts.push(opts.prompt as string);
      return { success: false, estimatedCost: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "TS error attempt 2" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 2 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    await autofixStage.execute(ctx);

    _autofixDeps.recheckReview = saved.recheckReview;

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Review failed after your implementation");
    expect(prompts[0]).not.toContain("Your previous fix attempt did not resolve all issues");
    expect(prompts[1]).toContain("Your previous fix attempt did not resolve all issues");
    expect(prompts[1]).not.toContain("Review failed after your implementation");
  });

  test("resets to first-attempt framing when failed check type changes between attempts", async () => {
    const prompts: string[] = [];
    const mockRun = mock(async (opts: Record<string, unknown>) => {
      prompts.push(opts.prompt as string);
      return { success: false, estimatedCost: 0 };
    });
    const agentManager = makeMockAgentManager(mockRun);
    const saved = { recheckReview: _autofixDeps.recheckReview };
    let recheckCount = 0;

    const ctx = makeCtx({
      agentManager,
      reviewResult: makeFailedReviewResult([{ check: "semantic", output: "AC mismatch" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 2 },
        },
        autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
      } as any,
    });

    _autofixDeps.recheckReview = async () => {
      recheckCount++;
      if (recheckCount === 1) {
        ctx.reviewResult = makeFailedReviewResult([{ check: "adversarial", output: "Security gap" }]);
      }
      return false;
    };

    await autofixStage.execute(ctx);

    _autofixDeps.recheckReview = saved.recheckReview;

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Review failed after your implementation");
    expect(prompts[1]).toContain("Review failed after your implementation");
    expect(prompts[1]).not.toContain("Your previous fix attempt did not resolve all issues");
  });
});
