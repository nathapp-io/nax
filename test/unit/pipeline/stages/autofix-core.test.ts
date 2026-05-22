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
    ...c,
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
  test.each([
    ["reviewResult is undefined", () => makeCtx()],
    ["review passed", () => makeCtx({ reviewResult: makeReviewResult(true) })],
    ["autofix.enabled = false", () => makeCtx({ reviewResult: makeReviewResult(false), config: { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, autofix: { enabled: false } } } as any })],
  ])("disabled when %s", (_label, makeTestCtx) => {
    expect(autofixStage.enabled(makeTestCtx())).toBe(false);
  });

  test("escalates when agent rectification fails (no fix commands or recheck fails after mechanical fix)", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runAgentRectification = async () => ({ succeeded: false, cost: 0 });

    const noFixCtx = makeCtx({
      reviewResult: makeFailedReviewResult([{ check: "lint", output: "Unexpected token" }]),
      config: { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" }, autofix: { enabled: true } } } as any,
    });
    expect((await autofixStage.execute(noFixCtx)).action).toBe("escalate");

    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: false, exitCode: 1, output: "lint error", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;
    const recheckFailCtx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) });
    expect((await autofixStage.execute(recheckFailCtx)).action).toBe("escalate");

    Object.assign(_autofixDeps, saved);
  });

  test("returns retry when recheck passes; skips agent rectification when mechanical fix succeeds", async () => {
    const saved = { ..._autofixDeps };
    let agentRectificationCalled = false;
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => true;
    _autofixDeps.runAgentRectification = async () => { agentRectificationCalled = true; return { succeeded: true, cost: 0 }; };

    const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.fromStage).toBe("review");
    expect(agentRectificationCalled).toBe(false);
  });

  test("uses review lintFixScoped before quality lintFixScoped with shell-quoted scope files", async () => {
    const saved = { ..._autofixDeps };
    const commandsRun: string[] = [];
    _autofixDeps.runQualityCommand = async ({ command }) => {
      commandsRun.push(command);
      return { commandName: "lintFix", command, success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false };
    };
    _autofixDeps.recheckReview = async () => true;

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([
        {
          check: "lint",
          lintScope: {
            status: "in_scope",
            packageGroups: [{ packageDir: ".", files: ["src/a.ts", "src/has space's.ts"] }],
          },
        },
      ]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: {
            lintFix: "custom-lint --fix",
            lintFixScoped: "quality-fix {{files}}",
          },
          autofix: { enabled: true },
        },
        review: {
          ...DEFAULT_CONFIG.review,
          commands: { ...DEFAULT_CONFIG.review.commands, lintFixScoped: "review-fix {{files}}" },
        },
      } as any,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    expect(commandsRun).toEqual(["review-fix 'src/a.ts' 'src/has space'\\''s.ts'"]);
  });

  test("derives scoped lintFix from supported broad command when no scoped template is configured", async () => {
    const saved = { ..._autofixDeps };
    const commandsRun: string[] = [];
    _autofixDeps.runQualityCommand = async ({ command }) => {
      commandsRun.push(command);
      return { commandName: "lintFix", command, success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false };
    };
    _autofixDeps.recheckReview = async () => true;

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([
        {
          check: "lint",
          lintScope: {
            status: "in_scope",
            packageGroups: [{ packageDir: "apps/api", files: ["apps/api/src/a.ts"] }],
          },
        },
      ]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { lintFix: "biome check --fix" },
          autofix: { enabled: true },
        },
      } as any,
    });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(commandsRun).toEqual(["biome check --fix 'apps/api/src/a.ts'"]);
  });

  test("runs mechanical phase when only lintFixScoped is configured", async () => {
    const saved = { ..._autofixDeps };
    const commandsRun: string[] = [];
    _autofixDeps.runQualityCommand = async ({ command }) => {
      commandsRun.push(command);
      return { commandName: "lintFix", command, success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false };
    };
    _autofixDeps.recheckReview = async () => true;

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([
        {
          check: "lint",
          lintScope: { status: "in_scope", packageGroups: [{ packageDir: ".", files: ["src/a.ts"] }] },
        },
      ]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { lintFixScoped: "biome check --fix {{files}}" },
          autofix: { enabled: true },
        },
      } as any,
    });
    const result = await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(result.action).toBe("retry");
    expect(commandsRun).toEqual(["biome check --fix 'src/a.ts'"]);
  });

  test("empty scoped lint failure skips mechanical fix and still rechecks", async () => {
    const saved = { ..._autofixDeps };
    let commandRun = false;
    let recheckRun = false;
    _autofixDeps.runQualityCommand = async () => {
      commandRun = true;
      return { commandName: "lintFix", command: "", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false };
    };
    _autofixDeps.recheckReview = async () => {
      recheckRun = true;
      return true;
    };

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([
        {
          check: "lint",
          lintScope: { status: "in_scope", packageGroups: [{ packageDir: ".", files: [] }] },
        },
      ]),
    });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(commandRun).toBe(false);
    expect(recheckRun).toBe(true);
  });

  test("unsupported broad lintFix command degrades to full command with explicit fallback", async () => {
    const saved = { ..._autofixDeps };
    const commandsRun: string[] = [];
    _autofixDeps.runQualityCommand = async ({ command }) => {
      commandsRun.push(command);
      return { commandName: "lintFix", command, success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false };
    };
    _autofixDeps.recheckReview = async () => true;

    const ctx = makeCtx({
      reviewResult: makeFailedReviewResult([
        {
          check: "lint",
          lintScope: {
            status: "in_scope",
            packageGroups: [{ packageDir: ".", files: ["src/a.ts"] }],
          },
        },
      ]),
      config: {
        ...DEFAULT_CONFIG,
        quality: {
          ...DEFAULT_CONFIG.quality,
          commands: { lintFix: "bun run lint:fix" },
          autofix: { enabled: true },
        },
      } as any,
    });
    await autofixStage.execute(ctx);

    Object.assign(_autofixDeps, saved);

    expect(commandsRun).toEqual(["bun run lint:fix"]);
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

  test("agent rectification runs: when no fix commands configured and when mechanical fix fails", async () => {
    const saved = { ..._autofixDeps };

    // No fix commands configured
    let called1 = false;
    _autofixDeps.runAgentRectification = async () => { called1 = true; return { succeeded: false, cost: 0 }; };
    await autofixStage.execute(makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint", output: "Unexpected token" }]), config: { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" }, autofix: { enabled: true, maxAttempts: 2 } } } as any }));
    expect(called1).toBe(true);

    // Mechanical fix runs but recheck still fails
    let called2 = false;
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;
    _autofixDeps.runAgentRectification = async () => { called2 = true; return { succeeded: false, cost: 0 }; };
    await autofixStage.execute(makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }]) }));
    expect(called2).toBe(true);

    Object.assign(_autofixDeps, saved);
  });

  test("agent rectification succeeds → retry fromStage review; exhausted → escalate", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "", success: false, exitCode: 1, output: "", durationMs: 0, timedOut: false });
    _autofixDeps.recheckReview = async () => false;

    _autofixDeps.runAgentRectification = async () => ({ succeeded: true, cost: 0 });
    const retryResult = await autofixStage.execute(makeCtx({ reviewResult: makeFailedReviewResult([{ check: "typecheck" }]) }));
    expect(retryResult.action).toBe("retry");
    if (retryResult.action === "retry") expect(retryResult.fromStage).toBe("review");

    _autofixDeps.runAgentRectification = async () => ({ succeeded: false, cost: 0 });
    const escalateResult = await autofixStage.execute(makeCtx({ reviewResult: makeFailedReviewResult([{ check: "typecheck" }]) }));
    // reuse the saved-restore pattern below
    const result = escalateResult;

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

  test("zero progress escalates immediately even with budget; budget exhaustion escalates despite partial progress", async () => {
    const saved = { ..._autofixDeps };
    const baseCfg = { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" }, autofix: { enabled: true, maxAttempts: 3, maxTotalAttempts: 12 } } } as any;

    _autofixDeps.runAgentRectification = async (mockCtx: PipelineContext) => { mockCtx.autofixAttempt = 3; return { succeeded: false, cost: 1.5 }; };
    expect((await autofixStage.execute(makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }, { check: "typecheck" }]), config: baseCfg }))).action).toBe("escalate");

    _autofixDeps.runAgentRectification = async (mockCtx: PipelineContext) => { mockCtx.autofixAttempt = 12; mockCtx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "TS2345: Type error" }]); return { succeeded: false, cost: 0.5 }; };
    expect((await autofixStage.execute(makeCtx({ reviewResult: makeFailedReviewResult([{ check: "lint" }, { check: "typecheck" }]), config: baseCfg }))).action).toBe("escalate");

    Object.assign(_autofixDeps, saved);
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

  test("prompt includes failed check output, story ID, check name; includes scope constraint when workdir set", () => {
    const errorText = "Unused variable 'fooBar' at line 42";
    const failedChecks: ReviewCheckResult[] = [
      { check: "lint", success: false, command: "biome check", exitCode: 1, output: errorText, durationMs: 50 },
    ];
    const prompt = RectifierPromptBuilder.reviewRectification(failedChecks, { id: "US-002", title: "Add feature" } as any);
    expect(prompt).toContain(errorText);
    expect(prompt).toContain("US-002");
    expect(prompt).toContain("lint");
    expect(prompt).not.toContain("Only modify files within");

    const withWorkdir = RectifierPromptBuilder.reviewRectification(failedChecks, { id: "US-002", title: "Add feature", workdir: "apps/api" } as any);
    expect(withWorkdir).toContain("Only modify files within `apps/api/`");
    expect(withWorkdir).toContain("Do NOT touch files outside this directory");
  });
});

describe("autofixStage — unsignaled-failure guard (2D)", () => {
  test.each<[string, object]>([
    ["empty checks", { success: false, failureReason: "Gating LLM checks due to mechanical failure", checks: [] }],
    ["only git-clean check with no findings", { success: false, failureReason: "Working tree has uncommitted changes", checks: [{ check: "git-clean", success: false, command: "git status --porcelain", exitCode: 1, output: "?? src/foo.ts", durationMs: 0 }] }],
  ])("escalates when reviewResult has %s", async (_label, reviewResult) => {
    const ctx = makeCtx({ reviewResult: reviewResult as any });
    const result = await autofixStage.execute(ctx);
    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.reason).toContain("Review failed without actionable signal");
    }
  });

  test("proceeds (not escalate) when semantic check has findings and when lint failed", async () => {
    const saved = { ..._autofixDeps };
    try {
      _autofixDeps.runAgentRectification = async () => ({ succeeded: true, cost: 0 });
      const semanticResult = await autofixStage.execute(makeCtx({ reviewResult: { success: false, checks: [{ check: "semantic", success: false, command: "", exitCode: 1, output: "issues found", durationMs: 100, findings: [{ severity: "error", file: "a.ts", line: 1, message: "x", ruleId: "y" }] }] } as any }));
      expect(semanticResult.action).not.toBe("escalate");

      _autofixDeps.recheckReview = async () => true;
      _autofixDeps.runQualityCommand = async () => ({ commandName: "lintFix", command: "biome", success: true, exitCode: 0, output: "", durationMs: 0, timedOut: false });
      const lintResult = await autofixStage.execute(makeCtx({ reviewResult: { success: false, checks: [{ check: "lint", success: false, command: "biome check", exitCode: 1, output: "error", durationMs: 10 }] } as any }));
      expect(lintResult.action).not.toBe("escalate");
    } finally {
      Object.assign(_autofixDeps, saved);
    }
  });
});

describe("autofixStage — autofixAttempt counter (#951 Bug 1)", () => {
  test("increments ctx.autofixAttempt on each real entry; no-op when review passed", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runAgentRectification = async () => ({ succeeded: true, cost: 0 });
    try {
      const ctx = makeCtx({ reviewResult: makeFailedReviewResult([{ check: "typecheck", output: "ts err" }]) });
      expect(ctx.autofixAttempt ?? 0).toBe(0);
      await autofixStage.execute(ctx);
      expect(ctx.autofixAttempt).toBe(1);
      ctx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "ts err" }]);
      await autofixStage.execute(ctx);
      expect(ctx.autofixAttempt).toBe(2);
    } finally {
      Object.assign(_autofixDeps, saved);
    }

    const passedCtx = makeCtx({ reviewResult: makeReviewResult(true), autofixAttempt: 4 });
    await autofixStage.execute(passedCtx);
    expect(passedCtx.autofixAttempt).toBe(4);
  });
});

describe("autofixStage — capacity gate on partial-progress retry (#951 Bug 2)", () => {
  function priorIter(strategyNames: string[]): any {
    return {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: strategyNames.map((name) => ({ strategyName: name, op: name, targetFiles: [], summary: "" })),
      findingsAfter: [],
      outcome: "unchanged",
      startedAt: "2026-05-07T00:00:00.000Z",
      finishedAt: "2026-05-07T00:00:01.000Z",
    };
  }

  test("escalates when prior iterations exhaust strategy cap; retries when capacity remains", async () => {
    const saved = { ..._autofixDeps };
    _autofixDeps.runAgentRectification = async (mockCtx: PipelineContext) => {
      mockCtx.reviewResult = makeFailedReviewResult([{ check: "typecheck", output: "ts err" }]);
      return { succeeded: false, cost: 0 };
    };

    try {
      const exhaustedCtx = makeCtx({
        reviewResult: makeFailedReviewResult([{ check: "lint" }, { check: "typecheck" }]),
        config: { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" }, autofix: { enabled: true, maxAttempts: 2, maxTotalAttempts: 12 } } } as any,
      });
      exhaustedCtx.autofixPriorIterations = [priorIter(["autofix-implementer", "autofix-implementer"])];
      expect((await autofixStage.execute(exhaustedCtx)).action).toBe("escalate");

      const remainingCtx = makeCtx({
        reviewResult: makeFailedReviewResult([{ check: "lint" }, { check: "typecheck" }]),
        config: { ...DEFAULT_CONFIG, quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" }, autofix: { enabled: true, maxAttempts: 3, maxTotalAttempts: 12 } } } as any,
      });
      remainingCtx.autofixPriorIterations = [priorIter(["autofix-implementer"])];
      const retryResult = await autofixStage.execute(remainingCtx);
      expect(retryResult.action).toBe("retry");
      if (retryResult.action === "retry") expect(retryResult.fromStage).toBe("review");
    } finally {
      Object.assign(_autofixDeps, saved);
    }
  });
});
