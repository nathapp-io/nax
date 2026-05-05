// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { _autofixDeps, autofixStage } from "../../../../src/pipeline/stages/autofix";
import { RectifierPromptBuilder } from "../../../../src/prompts";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { ReviewCheckResult } from "../../../../src/review/types";

function makeReviewResult(success: boolean) {
  return { success, checks: [], summary: "" } as any;
}

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

describe("autofixStage", () => {
  test("disabled when reviewResult is undefined", () => {
    expect(autofixStage.enabled(makeCtx())).toBe(false);
  });

  test("disabled when review passed", () => {
    expect(autofixStage.enabled(makeCtx({ reviewResult: makeReviewResult(true) }))).toBe(false);
  });

  test("disabled when autofix.enabled = false", () => {
    const ctx = makeCtx({
      reviewResult: makeReviewResult(false),
      config: {
        ...DEFAULT_CONFIG,
        quality: { ...DEFAULT_CONFIG.quality, autofix: { enabled: false } },
      } as any,
    });
    expect(autofixStage.enabled(ctx)).toBe(false);
  });

  test("escalates when no fix commands configured and agent rectification fails", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runAgentRectification = async () => ({ succeeded: false, cost: 0 });

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint", output: "Unexpected token" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true },
        },
      } as any,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });

  test("returns retry when recheck passes", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => true;

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("review");
  });

  test("recheck pass: skipped checks are not added to retrySkipChecks", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({
      commandName: "lintFix",
      command: "",
      success: true,
      exitCode: 0,
      output: "",
      durationMs: 0,
      timedOut: false,
    });
    _autofixDeps.recheckReview = async (mockCtx: PipelineContext) => {
      mockCtx.reviewResult = {
        success: true,
        checks: [
          {
            check: "typecheck",
            success: true,
            command: "tsc --noEmit",
            exitCode: 0,
            output: "",
            durationMs: 10,
          },
          {
            check: "semantic",
            success: true,
            skipped: true,
            command: "gated",
            exitCode: 0,
            output: "skipped",
            durationMs: 0,
          },
        ],
      } as any;
      return true;
    };

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    expect(ctx.retrySkipChecks?.has("typecheck")).toBe(true);
    expect(ctx.retrySkipChecks?.has("semantic")).toBe(false);
  });

  test("escalates when recheck still fails and agent rectification also fails", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: false, exitCode: 1, output: "lint error", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({ succeeded: false, cost: 0 });

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });

  test("agent rectification runs when no fix commands configured", async () => {
    const saved = { ..._autofixDeps };
    let agentRectificationCalled = false;
    _autofixDeps.runAgentRectification = async () => {
      agentRectificationCalled = true;
      return { succeeded: false, cost: 0 };
    };

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint", output: "Unexpected token" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 2 },
        },
      } as any,
    });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(agentRectificationCalled).toBe(true);
  });

  test("agent rectification runs when mechanical fix fails", async () => {
    const saved = { ..._autofixDeps };
    let agentRectificationCalled = false;
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => {
      agentRectificationCalled = true;
      return { succeeded: false, cost: 0 };
    };

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(agentRectificationCalled).toBe(true);
  });

  test("agent rectification succeeds → returns retry fromStage review", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: false, exitCode: 1, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({ succeeded: true, cost: 0 });

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "typecheck" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("review");
  });

  test("agent rectification exhausted → returns escalate", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: false, exitCode: 1, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({ succeeded: false, cost: 0 });

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "typecheck" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });

  // D6 — escalation digest used as reason when available (#897)
  test("escalation reason uses digest from rectification when available", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({
      succeeded: false,
      cost: 0,
      escalationDigest: "Autofix exhausted: 3 findings remain\n  - error-path × 2 in src/foo.ts",
    });

    // Use a non-empty check so the 2D unsignaled-failure guard does not intercept.
    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "semantic", output: "issues" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.reason).toContain("error-path");
      expect(result.reason).toContain("src/foo.ts");
    }
  });

  test("partial progress — cleared checks added to skip list, returns retry when budget remains", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runAgentRectification = async (mockCtx: PipelineContext) => {
      mockCtx.autofixAttempt = 3;
      mockCtx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "TS2345: Type error" }]);
      return { succeeded: false, cost: 1.5 };
    };

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint" }, { check: "typecheck" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 3, maxTotalAttempts: 12 },
        },
      } as any,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("review");
    expect(ctx.retrySkipChecks?.has("lint")).toBe(true);
    expect(ctx.retrySkipChecks?.has("typecheck")).toBe(false);
  });

  test("zero progress — escalates immediately even when budget remains", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runAgentRectification = async (mockCtx: PipelineContext) => {
      mockCtx.autofixAttempt = 3;
      return { succeeded: false, cost: 1.5 };
    };

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint" }, { check: "typecheck" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 3, maxTotalAttempts: 12 },
        },
      } as any,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });

  test("budget exhausted — escalates even when partial progress was made", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runAgentRectification = async (mockCtx: PipelineContext) => {
      mockCtx.autofixAttempt = 12;
      mockCtx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "TS2345: Type error" }]);
      return { succeeded: false, cost: 0.5 };
    };

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint" }, { check: "typecheck" }]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { test: "bun test" },
          autofix: { enabled: true, maxAttempts: 3, maxTotalAttempts: 12 },
        },
      } as any,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });

  test("agent rectification skipped when review passes after mechanical fix", async () => {
    const saved = { ..._autofixDeps };
    let agentRectificationCalled = false;
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => true;
    _autofixDeps.runAgentRectification = async () => {
      agentRectificationCalled = true;
      return { succeeded: true, cost: 0 };
    };

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    expect(agentRectificationCalled).toBe(false);
  });

  test("typecheck failure skips mechanical fix and goes straight to agent rectification", async () => {
    const saved = { ..._autofixDeps };
    let runQualityCommandCalled = false;
    let agentRectificationCalled = false;
    _autofixDeps.runQualityCommand = async () => {
      runQualityCommandCalled = true;
      return { commandName: "lintFix", command: "", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false };
    };
    _autofixDeps.runAgentRectification = async () => {
      agentRectificationCalled = true;
      return { succeeded: false, cost: 0 };
    };

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "TS2345: Type error" }]) });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(runQualityCommandCalled).toBe(false);
    expect(agentRectificationCalled).toBe(true);
  });

  test("prompt includes failed check output", async () => {
    const errorText = "Unused variable 'fooBar' at line 42";
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
    const story = { id: "US-002", title: "Add feature" } as any;

    const prompt = RectifierPromptBuilder.reviewRectification(failedChecks, story);

    expect(prompt).toContain(errorText);
    expect(prompt).toContain("US-002");
    expect(prompt).toContain("lint");
  });

  test("ENH-008: includes scope constraint when story.workdir is set", () => {
    const failedChecks: ReviewCheckResult[] = [
      { check: "lint", success: false, command: "biome check", exitCode: 1, output: "error", durationMs: 10 },
    ];
    const story = { id: "US-002", title: "Add feature", workdir: "apps/api" } as any;

    const prompt = RectifierPromptBuilder.reviewRectification(failedChecks, story);

    expect(prompt).toContain("Only modify files within `apps/api/`");
    expect(prompt).toContain("Do NOT touch files outside this directory");
  });

  test("ENH-008: no scope constraint when story.workdir is not set", () => {
    const failedChecks: ReviewCheckResult[] = [
      { check: "lint", success: false, command: "biome check", exitCode: 1, output: "error", durationMs: 10 },
    ];
    const story = { id: "US-002", title: "Add feature" } as any;

    const prompt = RectifierPromptBuilder.reviewRectification(failedChecks, story);

    expect(prompt).not.toContain("Only modify files within");
  });
});

describe("autofixStage — unsignaled-failure guard (2D)", () => {
  test("escalates when reviewResult.checks is empty", async () => {
    const ctx = makeCtx({
      reviewResult: {
        success: false,
        failureReason: "Gating LLM checks due to mechanical failure",
        checks: [],
      } as any,
    });
    const result = await autofixStage.execute(ctx);
    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.reason).toContain("Review failed without actionable signal");
    }
  });

  test("escalates when only failed check is git-clean with no findings", async () => {
    const ctx = makeCtx({
      reviewResult: {
        success: false,
        failureReason: "Working tree has uncommitted changes",
        checks: [
          {
            check: "git-clean",
            success: false,
            command: "git status --porcelain",
            exitCode: 1,
            output: "?? src/foo.ts",
            durationMs: 0,
          },
        ],
      } as any,
    });
    const result = await autofixStage.execute(ctx);
    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.reason).toContain("Review failed without actionable signal");
    }
  });

  test("proceeds when semantic check has findings", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runAgentRectification = async () => ({ succeeded: true, cost: 0 });

    try {
      const ctx = makeCtx({
        reviewResult: {
          success: false,
          checks: [
            {
              check: "semantic",
              success: false,
              command: "",
              exitCode: 1,
              output: "issues found",
              durationMs: 100,
              findings: [{ severity: "error", file: "a.ts", line: 1, message: "x", ruleId: "y" }],
            },
          ],
        } as any,
      });
      const result = await autofixStage.execute(ctx);
      expect(result.action).not.toBe("escalate");
    } finally {
      Object.assign(_autofixDeps, saved);
    }
  });

  test("proceeds when lint failed (mechanically fixable, guard does not fire)", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.recheckReview = async () => true;
    _autofixDeps.runQualityCommand = async () =>
      ({ commandName: "lintFix", command: "biome", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false });

    try {
      const ctx = makeCtx({
        reviewResult: {
          success: false,
          checks: [
            { check: "lint", success: false, command: "biome check", exitCode: 1, output: "error", durationMs: 10 },
          ],
        } as any,
      });
      const result = await autofixStage.execute(ctx);
      expect(result.action).not.toBe("escalate");
    } finally {
      Object.assign(_autofixDeps, saved);
    }
  });
});
