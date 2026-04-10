// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { _autofixDeps, autofixStage, buildReviewRectificationPrompt } from "../../../../src/pipeline/stages/autofix";
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
    hooks: {},
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
      reviewResult: makeReviewResult(false),
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

    // Must have a lint failure to trigger Phase 1 (mechanical fix)
    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("review");
  });

  test("escalates when recheck still fails and agent rectification also fails", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: false, exitCode: 1, output: "lint error", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({ succeeded: false, cost: 0 });

    const ctx = makeCtx({ reviewResult: makeReviewResult(false) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("escalate");
  });

  // AUTOFIX-004 tests

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

    const ctx = makeCtx({ reviewResult: makeReviewResult(false) });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(agentRectificationCalled).toBe(true);
  });

  test("agent rectification succeeds → returns retry fromStage review", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: false, exitCode: 1, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => ({ succeeded: true, cost: 0 });

    const ctx = makeCtx({ reviewResult: makeReviewResult(false) });
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

    const ctx = makeCtx({ reviewResult: makeReviewResult(false) });
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

    // Must have a lint failure to trigger Phase 1 (mechanical fix)
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

    // Only typecheck failed — no lint failure → Phase 1 (mechanical fix) should be skipped
    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "TS2345: Type error" }]) });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(runQualityCommandCalled).toBe(false); // lintFix/formatFix not called
    expect(agentRectificationCalled).toBe(true); // went straight to agent
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

    const prompt = buildReviewRectificationPrompt(failedChecks, story);

    expect(prompt).toContain(errorText);
    expect(prompt).toContain("US-002");
    expect(prompt).toContain("lint");
  });

  test("ENH-008: includes scope constraint when story.workdir is set", () => {
    const failedChecks = [
      { check: "lint", success: false, command: "biome check", exitCode: 1, output: "error", durationMs: 10 },
    ];
    const story = { id: "US-002", title: "Add feature", workdir: "apps/api" } as any;

    const prompt = buildReviewRectificationPrompt(failedChecks, story);

    expect(prompt).toContain("Only modify files within `apps/api/`");
    expect(prompt).toContain("Do NOT touch files outside this directory");
  });

  test("ENH-008: no scope constraint when story.workdir is not set", () => {
    const failedChecks = [
      { check: "lint", success: false, command: "biome check", exitCode: 1, output: "error", durationMs: 10 },
    ];
    const story = { id: "US-002", title: "Add feature" } as any;

    const prompt = buildReviewRectificationPrompt(failedChecks, story);

    expect(prompt).not.toContain("Only modify files within");
  });

  test("#106: global autofix budget — ctx.autofixAttempt persists across cycles", async () => {
    const saved = { ..._autofixDeps };
    // Agent always "fails" so we exhaust attempts
    let agentSpawnCount = 0;
    _autofixDeps.getAgent = () =>
      ({
        run: async () => {
          agentSpawnCount++;
          return { success: false };
        },
      }) as any;
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
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

    // Simulate 3 review→autofix cycles by calling execute repeatedly
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
    expect(agentSpawnCount).toBe(5); // only 1 more, not 2

    // Cycle 4: budget exhausted — no more spawns
    ctx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "TS error" }]);
    await autofixStage.execute(ctx);
    expect(ctx.autofixAttempt).toBe(5); // unchanged
    expect(agentSpawnCount).toBe(5); // no more spawns

    Object.assign(_autofixDeps, saved);
  });

  test("injects rethink prompt on configured autofix attempt", async () => {
    const saved = { ..._autofixDeps };
    const prompts: string[] = [];

    _autofixDeps.getAgent = () =>
      ({
        run: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return { success: false };
        },
      }) as any;
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
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

    Object.assign(_autofixDeps, saved);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Rethink your approach");
    expect(prompts[1]).toContain("Rethink your approach");
    expect(prompts[1]).toContain("Final Autofix Attempt Before Escalation");
  });

  test("injects urgency and rethink when urgencyAtAttempt is reached", async () => {
    const saved = { ..._autofixDeps };
    const prompts: string[] = [];

    _autofixDeps.getAgent = () =>
      ({
        run: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return { success: false };
        },
      }) as any;
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
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

    Object.assign(_autofixDeps, saved);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Rethink your approach");
    expect(prompts[1]).toContain("Rethink your approach");
    expect(prompts[1]).toContain("Final Autofix Attempt Before Escalation");
  });

  test("uses default rethink and urgency thresholds when autofix escalation config is not set", async () => {
    const saved = { ..._autofixDeps };
    const prompts: string[] = [];

    _autofixDeps.getAgent = () =>
      ({
        run: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return { success: false };
        },
      }) as any;
    _autofixDeps.recheckReview = async () => false;

    const ctx = makeCtx({
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

    Object.assign(_autofixDeps, saved);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Rethink your approach");
    expect(prompts[0]).not.toContain("Final Autofix Attempt Before Escalation");
    expect(prompts[1]).toContain("Rethink your approach");
    expect(prompts[1]).toContain("Final Autofix Attempt Before Escalation");
  });
});
