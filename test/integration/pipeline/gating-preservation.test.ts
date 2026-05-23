/**
 * Gating-preservation integration tests (US-005b)
 *
 * Verifies every config-driven gate behaves identically under the unified
 * builder path (assemblePlanInputsFromCtx → buildPlanForStrategy).
 * Provides the safety net for US-005c's destructive cleanup.
 *
 * Scope: integration tests only — no production code changes.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "@/config";
import {
  assemblePlanInputsFromCtx,
  buildPlanForStrategy,
  _storyOrchestratorDeps,
} from "@/execution";
import {
  makeMechanicalFormatFixStrategy,
  makeMechanicalLintFixStrategy,
} from "@/operations";
import type { CallContext } from "@/operations";
import type { PipelineContext } from "@/pipeline/types";
import type { NaxRuntime } from "@/runtime";
import {
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal resolved patterns used by greenfield-gate inputs. */
const MINIMAL_PATTERNS = {
  globs: ["test/**/*.test.ts"],
  regex: [/\.test\.ts$/],
  pathspec: [":(exclude)test/**/*.test.ts"],
  testDirs: ["test/unit", "test/integration"],
} as const;

/**
 * Minimal non-TDD PipelineContext for assemblePlanInputsFromCtx.
 * Only accesses config, story, routing.testStrategy, prompt, and workdir
 * for non-TDD strategies — dispatch fields are not touched.
 */
function makeNonTddCtx(config: NaxConfig): PipelineContext {
  const story = makeStory();
  return {
    config,
    rootConfig: config,
    story,
    stories: [story],
    prd: makePRD({ userStories: [story] }),
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "no-test" as const,
      reasoning: "",
    },
    workdir: "/tmp/test",
    projectDir: "/tmp/test",
    hooks: { hooks: {} },
    prompt: "Implement the feature.",
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock setup for tests that call plan.run()
// ─────────────────────────────────────────────────────────────────────────────

function makeRunFixCycleMock(capturedNames: string[]) {
  return mock(async (cycle: { strategies: Array<{ name: string }> }) => {
    capturedNames.push(...cycle.strategies.map((s) => s.name));
    return {
      iterations: [],
      finalFindings: [],
      exitReason: "no-strategy" as const,
      costUsd: 0,
    };
  }) as typeof _storyOrchestratorDeps.runFixCycle;
}

function makeCallOpMock() {
  return mock(async (_ctx: unknown, op: { name: string }) => {
    if (op.name === "verifier") {
      return {
        success: false,
        findings: [{ source: "test-runner", severity: "error", message: "test failed" }],
      };
    }
    return { success: true };
  }) as typeof _storyOrchestratorDeps.callOp;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: review.enabled=true, review.checks=["lint"] → lint-check only
// ─────────────────────────────────────────────────────────────────────────────

describe("AC1: review.checks=['lint'] gates lint-check in, typecheck/semantic/adversarial out", () => {
  test("assemblePlanInputsFromCtx produces lintCheck input but not typecheckCheck or review inputs", async () => {
    const config = makeNaxConfig({
      review: { enabled: true, checks: ["lint"] },
      quality: { commands: { lintCheck: "bun run lint:check" } },
    });
    const inputs = await assemblePlanInputsFromCtx(makeNonTddCtx(config));
    expect(inputs.lintCheck).toBeDefined();
    expect(inputs.typecheckCheck).toBeUndefined();
    expect(inputs.semanticReview).toBeUndefined();
    expect(inputs.adversarialReview).toBeUndefined();
  });

  test("plan phaseNames includes lint-check but not typecheck-check, semantic-review, adversarial-review", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      review: { enabled: true, checks: ["lint"] },
      quality: { commands: { lintCheck: "bun run lint:check" } },
    });
    const inputs = await assemblePlanInputsFromCtx(makeNonTddCtx(config));
    const ctx = makeMockCallContext();
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    const names = plan.phaseNames();
    expect(names).toContain("lint-check");
    expect(names).not.toContain("typecheck-check");
    expect(names).not.toContain("semantic-review");
    expect(names).not.toContain("adversarial-review");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: review.enabled=false → no review/check phase outputs
// ─────────────────────────────────────────────────────────────────────────────

describe("AC2: review.enabled=false → no review/check phases in plan", () => {
  test("assemblePlanInputsFromCtx produces no review or check inputs when review disabled", async () => {
    const config = makeNaxConfig({
      review: { enabled: false },
    });
    const inputs = await assemblePlanInputsFromCtx(makeNonTddCtx(config));
    expect(inputs.lintCheck).toBeUndefined();
    expect(inputs.typecheckCheck).toBeUndefined();
    expect(inputs.semanticReview).toBeUndefined();
    expect(inputs.adversarialReview).toBeUndefined();
  });

  test("plan phaseNames contains none of lint-check, typecheck-check, semantic-review, adversarial-review", () => {
    const story = makeStory();
    const config = makeNaxConfig({ review: { enabled: false } });
    const inputs = makeMockPlanInputs({ story, config, implementer: { story } });
    const ctx = makeMockCallContext();
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    const names = plan.phaseNames();
    expect(names).not.toContain("lint-check");
    expect(names).not.toContain("typecheck-check");
    expect(names).not.toContain("semantic-review");
    expect(names).not.toContain("adversarial-review");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: command missing → check phase absent even when check is in review.checks
// ─────────────────────────────────────────────────────────────────────────────

describe("AC3: quality.commands.lintCheck/typecheckCheck undefined → check inputs absent", () => {
  test("lint in review.checks but quality.commands.lintCheck undefined → no lintCheck input", async () => {
    const config = makeNaxConfig({
      review: { enabled: true, checks: ["lint", "typecheck"] },
      quality: { commands: {} },
    });
    const inputs = await assemblePlanInputsFromCtx(makeNonTddCtx(config));
    expect(inputs.lintCheck).toBeUndefined();
  });

  test("typecheck in review.checks but quality.commands.typecheckCheck undefined → no typecheckCheck input", async () => {
    const config = makeNaxConfig({
      review: { enabled: true, checks: ["typecheck"] },
      quality: { commands: { lintCheck: "bun run lint:check" } },
    });
    const inputs = await assemblePlanInputsFromCtx(makeNonTddCtx(config));
    expect(inputs.typecheckCheck).toBeUndefined();
  });

  test("lintCheck command defined but typecheck not in checks → no typecheckCheck even if command present", async () => {
    const config = makeNaxConfig({
      review: { enabled: true, checks: ["lint"] },
      quality: { commands: { lintCheck: "bun run lint:check", typecheckCheck: "bun run typecheck" } },
    });
    const inputs = await assemblePlanInputsFromCtx(makeNonTddCtx(config));
    expect(inputs.lintCheck).toBeDefined();
    expect(inputs.typecheckCheck).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 + AC5: fix strategy gating
// ─────────────────────────────────────────────────────────────────────────────

describe("AC4-AC5: fix strategy gating in rectification phase", () => {
  let capturedStrategyNames: string[] = [];
  let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let runtime: NaxRuntime;

  beforeEach(() => {
    capturedStrategyNames = [];
    origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    origCallOp = _storyOrchestratorDeps.callOp;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;

    _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
    _storyOrchestratorDeps.callOp = makeCallOpMock();
    _storyOrchestratorDeps.runFixCycle = makeRunFixCycleMock(capturedStrategyNames);
  });

  afterEach(async () => {
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    await runtime?.close();
  });

  function makeRectifyInputs(story: ReturnType<typeof makeStory>, config: NaxConfig) {
    runtime = makeTestRuntime({ config });
    return {
      ctx: makeMockCallContext({ runtime }),
      inputs: makeMockPlanInputs({
        story,
        implementer: { story },
        fullSuiteGate: { story, workdir: "/tmp/test" },
        verifier: { story },
        rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
      }),
    };
  }

  // AC4: autofix.enabled=false
  test("AC4: autofix.enabled=false → no autofix-implementer or autofix-test-writer strategies", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: {
        commands: { lintFix: "bun run lint:fix" },
        autofix: { enabled: false },
      },
      execution: { rectification: { enabled: true, maxRetries: 2 } },
    });
    const { ctx, inputs } = makeRectifyInputs(story, config);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).not.toContain("autofix-implementer");
    expect(capturedStrategyNames).not.toContain("autofix-test-writer");
  });

  test("AC4: autofix.enabled=false but lintFix configured → mechanical-lintfix still assembled", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: {
        commands: { lintFix: "bun run lint:fix" },
        autofix: { enabled: false },
      },
      execution: { rectification: { enabled: true, maxRetries: 2 } },
    });
    const { ctx, inputs } = makeRectifyInputs(story, config);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("mechanical-lintfix");
  });

  // AC5: lintFix/lintFixScoped undefined → no mechanical-lintfix
  test("AC5: lintFix and lintFixScoped both undefined → no mechanical-lintfix strategy", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: {
        commands: { formatFix: "bun run format:fix" },
        autofix: { enabled: true },
      },
      execution: { rectification: { enabled: true, maxRetries: 2 } },
    });
    const { ctx, inputs } = makeRectifyInputs(story, config);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).not.toContain("mechanical-lintfix");
    expect(capturedStrategyNames).toContain("mechanical-formatfix");
  });

  test("AC5: formatFix and formatFixScoped both undefined → no mechanical-formatfix strategy", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: {
        commands: { lintFix: "bun run lint:fix" },
        autofix: { enabled: true },
      },
      execution: { rectification: { enabled: true, maxRetries: 2 } },
    });
    const { ctx, inputs } = makeRectifyInputs(story, config);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).not.toContain("mechanical-formatfix");
    expect(capturedStrategyNames).toContain("mechanical-lintfix");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: mechanical fix early exit without invoking runQualityCommand
// ─────────────────────────────────────────────────────────────────────────────

describe("AC6: mechanical fix fixOp.execute returns early when both commands undefined", () => {
  test("makeMechanicalLintFixStrategy: returns {applied:true, exitCode:0} without calling runQualityCommand", async () => {
    const config = makeNaxConfig({ quality: { commands: {} } });
    const mockCtx = { config } as unknown as CallContext;
    let called = false;
    const mockDeps = {
      runQualityCommand: async () => {
        called = true;
        return { exitCode: 0, output: "" };
      },
    };
    const strategy = makeMechanicalLintFixStrategy();
    const result = await strategy.fixOp.execute(
      { workdir: "/tmp/test", storyId: "US-001" },
      mockCtx,
      mockDeps,
    );
    expect(result).toEqual({ applied: true, exitCode: 0 });
    expect(called).toBe(false);
  });

  test("makeMechanicalFormatFixStrategy: returns {applied:true, exitCode:0} without calling runQualityCommand", async () => {
    const config = makeNaxConfig({ quality: { commands: {} } });
    const mockCtx = { config } as unknown as CallContext;
    let called = false;
    const mockDeps = {
      runQualityCommand: async () => {
        called = true;
        return { exitCode: 0, output: "" };
      },
    };
    const strategy = makeMechanicalFormatFixStrategy();
    const result = await strategy.fixOp.execute(
      { workdir: "/tmp/test", storyId: "US-001" },
      mockCtx,
      mockDeps,
    );
    expect(result).toEqual({ applied: true, exitCode: 0 });
    expect(called).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: full-path regression scenarios under unified builder path
// ─────────────────────────────────────────────────────────────────────────────

describe("AC7: full-path regression scenarios under unified path", () => {
  test("TDD success path: fresh three-session plan includes test-writer through verifier in order", () => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      testWriter: { story },
      greenfieldGate: { story, workdir: "/tmp/test", resolvedTestPatterns: MINIMAL_PATTERNS },
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
    });
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "verifier",
    ]);
  });

  test("partial-progress retry: story.attempts=1 omits test-writer and greenfield-gate", () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
    });
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names).not.toContain("test-writer");
    expect(names).not.toContain("greenfield-gate");
    expect(names).toContain("implementer");
    expect(names).toContain("full-suite-gate");
    expect(names).toContain("verifier");
  });

  test("non-TDD path: no-test strategy includes implementer and verify-scoped, excludes TDD phases", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
    });
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    const names = plan.phaseNames();
    expect(names).toContain("implementer");
    expect(names).toContain("verify-scoped");
    expect(names).not.toContain("test-writer");
    expect(names).not.toContain("full-suite-gate");
    expect(names).not.toContain("verifier");
  });

  test("TDD failure-then-fix path: rectification phase included when enabled and inputs present", () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxRetries: 2 } },
    });
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: true },
    });
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toContain("rectification");
  });

  test("mechanical-only failure suppression: autofix=false + lintFix → only mechanical strategies", async () => {
    const capturedNames: string[] = [];
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    const runtime = makeTestRuntime();

    try {
      _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
      _storyOrchestratorDeps.callOp = makeCallOpMock();
      _storyOrchestratorDeps.runFixCycle = makeRunFixCycleMock(capturedNames);

      const story = makeStory({ attempts: 1 });
      const config = makeNaxConfig({
        quality: {
          commands: { lintFix: "bun run lint:fix" },
          autofix: { enabled: false },
        },
        execution: { rectification: { enabled: true, maxRetries: 2 } },
      });
      const ctx = makeMockCallContext({ runtime });
      const inputs = makeMockPlanInputs({
        story,
        implementer: { story },
        fullSuiteGate: { story, workdir: "/tmp/test" },
        verifier: { story },
        rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
      });
      const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
      await plan.run();

      expect(capturedNames).toContain("mechanical-lintfix");
      expect(capturedNames).not.toContain("autofix-implementer");
      expect(capturedNames).not.toContain("autofix-test-writer");
    } finally {
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
      await runtime.close();
    }
  });

});
