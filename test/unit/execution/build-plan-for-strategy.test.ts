/**
 * Tests for buildPlanForStrategy — AC#4 refactor.
 *
 * buildPlanForStrategy now returns an ExecutionPlan instead of a PlanForStrategy boolean-bag.
 * Fresh/retry detection is derived from story.attempts and story.priorFailures — not from
 * an external isFreshRun flag.
 *
 * Use plan.phaseNames() to inspect the set of included phases.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TestStrategy } from "@/config/schema-types";
import { ExecutionPlan, buildPlanForStrategy } from "@/execution";
import type { PlanInputs } from "@/execution";
import { _storyOrchestratorDeps } from "@/execution";
import {
  makeAutofixImplementerStrategy,
  makeAutofixTestWriterStrategy,
  makeDeclarationSink,
} from "@/operations";
import type { UserStory } from "@/prd/types";
import type { NaxRuntime } from "@/runtime";
import { _rollbackDeps } from "@/tdd";
import { makeMockCallContext, makeMockPlanInputs, makeNaxConfig, makeStory, makeTestRuntime } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Typed input factories — populate the slot inputs each test needs
// ─────────────────────────────────────────────────────────────────────────────

function makeImplementerInput(story: UserStory): import("@/operations").ImplementerInput {
  return { story };
}

function makeTestWriterInput(story: UserStory): import("@/operations").TestWriterInput {
  return { story };
}

function makeVerifierInput(story: UserStory): import("@/operations").VerifierInput {
  return { story };
}

function makeGreenfieldGateInput(story: UserStory): import("@/operations").GreenfieldGateInput {
  return {
    story,
    workdir: "/tmp/test",
    resolvedTestPatterns: {
      globs: ["test/**/*.test.ts"],
      regex: [/\.test\.ts$/],
      pathspec: [":(exclude)test/**/*.test.ts"],
      testDirs: ["test/unit", "test/integration"],
    },
  };
}

function makeFullSuiteGateInput(story: UserStory): import("@/operations").FullSuiteGateInput {
  return { story, workdir: "/tmp/test" };
}

/** Inputs for a TDD fresh run. */
function makeTddFreshInputs(story: UserStory, extra: Partial<PlanInputs> = {}): PlanInputs {
  return makeMockPlanInputs({
    story,
    testWriter: makeTestWriterInput(story),
    greenfieldGate: makeGreenfieldGateInput(story),
    implementer: makeImplementerInput(story),
    fullSuiteGate: makeFullSuiteGateInput(story),
    verifier: makeVerifierInput(story),
    ...extra,
  });
}

/** Inputs for a TDD retry run (no test-writer / greenfield-gate inputs). */
function makeTddRetryInputs(story: UserStory, extra: Partial<PlanInputs> = {}): PlanInputs {
  return makeMockPlanInputs({
    story,
    implementer: makeImplementerInput(story),
    fullSuiteGate: makeFullSuiteGateInput(story),
    verifier: makeVerifierInput(story),
    ...extra,
  });
}

/** Inputs for a non-TDD single-session run. */
function makeNonTddInputs(story: UserStory, extra: Partial<PlanInputs> = {}): PlanInputs {
  return makeMockPlanInputs({
    story,
    implementer: makeImplementerInput(story),
    ...extra,
  });
}

function withRectification(enabled: boolean) {
  return makeNaxConfig({
    execution: {
      rectification: enabled ? { enabled: true, maxAttemptsTotal: 12 } : { enabled: false },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Return type
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — returns ExecutionPlan", () => {
  test("returns an ExecutionPlan instance", async () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan).toBeInstanceOf(ExecutionPlan);
  });

  test("plan has phaseNames() method", async () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(typeof plan.phaseNames).toBe("function");
    expect(Array.isArray(plan.phaseNames())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fresh vs retry detection — derived from story.attempts + priorFailures
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — fresh vs retry detection", () => {
  test("story.attempts=0 (fresh) includes test-writer and greenfield-gate for TDD", async () => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names).toContain("test-writer");
    expect(names).toContain("greenfield-gate");
  });

  test("story.attempts=0 full TDD fresh run includes all core phases", async () => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toEqual(["test-writer", "greenfield-gate", "implementer", "full-suite-gate", "verifier"]);
  });

  test("story.attempts=1 (retry) omits test-writer and greenfield-gate for TDD", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddRetryInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names).not.toContain("test-writer");
    expect(names).not.toContain("greenfield-gate");
  });

  test("story.attempts=1 retry includes implementer, full-suite-gate, verifier", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddRetryInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toEqual(["implementer", "full-suite-gate", "verifier"]);
  });

  test("story with priorFailures stage=review is treated as retry", async () => {
    const story = makeStory({
      attempts: 0,
      priorFailures: [
        {
          attempt: 0,
          modelTier: "fast",
          stage: "review",
          summary: "review failed",
          timestamp: new Date().toISOString(),
        },
      ],
    });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddRetryInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names).not.toContain("test-writer");
    expect(names).not.toContain("greenfield-gate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-TDD single-session
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — non-TDD single-session", () => {
  test.each([
    ["no-test strategy", "no-test" as const],
    ["test-after strategy", "test-after" as const],
  ])("%s includes only implementer", async (_label, strategy) => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, strategy, inputs);
    expect(plan.phaseNames()).toEqual(["implementer"]);
  });

  // issue #1116: regressionGate.mode=per-story wires fullSuiteGateOp into non-TDD plans.
  test("non-TDD + regressionGate.mode=per-story + fullSuiteGate input → plan includes full-suite-gate", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      execution: { regressionGate: { mode: "per-story" } },
    });
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story, { fullSuiteGate: makeFullSuiteGateInput(story) });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toContain("full-suite-gate");
  });

  test("non-TDD + regressionGate.mode=deferred + fullSuiteGate input → plan does NOT include full-suite-gate", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      execution: { regressionGate: { mode: "deferred" } },
    });
    const ctx = makeMockCallContext();
    // Even when fullSuiteGate input is present, mode=deferred means it should not run per-story.
    const inputs = makeNonTddInputs(story, { fullSuiteGate: makeFullSuiteGateInput(story) });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).not.toContain("full-suite-gate");
  });

  test("non-TDD + no fullSuiteGate input → plan does NOT include full-suite-gate regardless of mode", async () => {
    const story = makeStory();
    const config = makeNaxConfig({
      execution: { regressionGate: { mode: "per-story" } },
    });
    const ctx = makeMockCallContext();
    // Input presence gate: fullSuiteGate must be present in inputs for the op to be added.
    const inputs = makeNonTddInputs(story); // no fullSuiteGate
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).not.toContain("full-suite-gate");
  });

  test("tdd-simple strategy includes only implementer (single-session, no test-writer/verifier)", async () => {
    // tdd-simple is a SINGLE-SESSION strategy: one agent writes tests AND
    // implements within the same session. It must NOT trigger the three-session
    // orchestration (no test-writer, greenfield-gate, full-suite-gate, or verifier).
    // See src/metrics/tracker.ts:142-143 for the canonical three-session list.
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story); // even with all inputs available
    const plan = await buildPlanForStrategy(ctx, story, config, "tdd-simple", inputs);
    expect(plan.phaseNames()).toEqual(["implementer"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TDD strategy variants
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — three-session TDD strategy variants", () => {
  // tdd-simple is NOT included — it is a single-session strategy that does not
  // dispatch test-writer, full-suite-gate, or verifier slots.
  const tddStrategies: TestStrategy[] = ["three-session-tdd", "three-session-tdd-lite"];

  test.each(tddStrategies)("%s fresh includes full-suite-gate and verifier", async (strategy) => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, strategy, inputs);
    const names = plan.phaseNames();
    expect(names).toContain("full-suite-gate");
    expect(names).toContain("verifier");
  });

  test.each(tddStrategies)("%s fresh omits full-suite-gate and verifier when inputs missing", async (strategy) => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    // Inputs without fullSuiteGate or verifier
    const inputs = makeMockPlanInputs({
      story,
      testWriter: makeTestWriterInput(story),
      greenfieldGate: makeGreenfieldGateInput(story),
      implementer: makeImplementerInput(story),
      // fullSuiteGate and verifier intentionally omitted
    });
    const plan = await buildPlanForStrategy(ctx, story, config, strategy, inputs);
    const names = plan.phaseNames();
    expect(names).not.toContain("full-suite-gate");
    expect(names).not.toContain("verifier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rectification
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — rectification", () => {
  test("rectification appears last when enabled and inputs.rectification provided", async () => {
    const story = makeStory({ attempts: 0 });
    const config = withRectification(true);
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story, {
      rectification: {
        maxAttempts: 2,
        strategies: [],
        abortOnIncreasingFailures: false,
      },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names[names.length - 1]).toBe("rectification");
  });

  test("rectification omitted when not enabled in config", async () => {
    const story = makeStory({ attempts: 0 });
    const config = withRectification(false);
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story, {
      rectification: {
        maxAttempts: 2,
        strategies: [],
        abortOnIncreasingFailures: false,
      },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).not.toContain("rectification");
  });

  test("rectification omitted when inputs.rectification is undefined even if config enabled", async () => {
    const story = makeStory({ attempts: 0 });
    const config = withRectification(true);
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    // No rectification in inputs
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).not.toContain("rectification");
  });

  test("AC-7: TDD with fullSuiteGate + rectification includes rectification phase", async () => {
    // When isTdd && inputs.fullSuiteGate, buildPlanForStrategy prepends fullSuiteRectifyStrategy.
    // phaseNames() confirms the rectification phase is wired.
    const story = makeStory({ attempts: 1 }); // retry — no test-writer
    const config = withRectification(true);
    const ctx = makeMockCallContext();
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 3, strategies: [], abortOnIncreasingFailures: true },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toContain("rectification");
  });

  test("AC-7: non-TDD with rectification still includes rectification phase (no gate strategy prepended)", async () => {
    const story = makeStory();
    const config = withRectification(true);
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toContain("rectification");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 AC3: new check phases wired in buildPlanForStrategy
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC3: new check phase wiring (US-005)", () => {
  test.each([
    ["verifyScoped input", "verifyScoped" as const, "verify-scoped"],
    ["lintCheck input", "lintCheck" as const, "lint-check"],
    ["typecheckCheck input", "typecheckCheck" as const, "typecheck-check"],
  ])("AC3: non-TDD + %s → plan includes '%s' phase", async (_label, inputKey, expectedPhase) => {
    const story = makeStory();
    const ctx = makeMockCallContext();
    const config = makeNaxConfig();
    const inputs = makeNonTddInputs(story, {
      [inputKey]: { workdir: "/tmp/test", storyId: story.id },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toContain(expectedPhase);
  });

  test("AC3: semanticReview input → plan includes 'semantic-review' phase", async () => {
    const story = makeStory();
    const ctx = makeMockCallContext();
    const config = makeNaxConfig();
    const inputs = makeNonTddInputs(story, {
      semanticReview: {
        workdir: "/tmp/test",
        story,
        semanticConfig: config.review.semantic!,
        mode: config.review.semantic!.diffMode,
      },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toContain("semantic-review");
  });

  test("AC3: adversarialReview input → plan includes 'adversarial-review' phase", async () => {
    const story = makeStory();
    const ctx = makeMockCallContext();
    const config = makeNaxConfig({
      review: {
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
        },
      },
    });
    const inputs = makeNonTddInputs(story, {
      adversarialReview: {
        story,
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toContain("adversarial-review");
  });

  test("AC3: TDD strategy does NOT receive verifyScoped phase (verifyScoped is non-TDD only)", async () => {
    const story = makeStory({ attempts: 1 });
    const ctx = makeMockCallContext();
    const config = makeNaxConfig();
    const inputs = makeTddRetryInputs(story, {
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).not.toContain("verify-scoped");
  });

  test("AC3: canonical order places post-implementer phases in sequence", async () => {
    const story = makeStory();
    const ctx = makeMockCallContext();
    const config = makeNaxConfig({
      review: {
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
        },
      },
    });
    const inputs = makeNonTddInputs(story, {
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
      lintCheck: { workdir: "/tmp/test", storyId: story.id },
      typecheckCheck: { workdir: "/tmp/test", storyId: story.id },
      semanticReview: {
        workdir: "/tmp/test",
        story,
        semanticConfig: config.review.semantic!,
        mode: config.review.semantic!.diffMode,
      },
      adversarialReview: {
        story,
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toEqual([
      "implementer",
      "verify-scoped",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 AC4: fix strategy assembly in buildPlanForStrategy
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC4: fix strategy assembly (US-005)", () => {
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
    // Mock callOp: verifier returns failing output with test-runner finding so rectification triggers
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "verifier") {
        return { success: false, findings: [{ source: "test-runner", severity: "error", message: "test failed" }] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: { strategies: Array<{ name: string }> }) => {
      capturedStrategyNames = cycle.strategies.map((s) => s.name);
      return { iterations: [], finalFindings: [], exitReason: "no-strategy" as const, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;
  });

  afterEach(async () => {
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    await runtime?.close();
  });

  function makeCtxWithRuntime(config = makeNaxConfig()) {
    runtime = makeTestRuntime({ config });
    return makeMockCallContext({ runtime });
  }

  test("AC4: lintFix command configured → mechanical-lintfix strategy assembled in rectification", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { commands: { lintFix: "bun run lint:fix" } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("mechanical-lintfix");
  });

  test("AC4: formatFix command configured → mechanical-formatfix strategy assembled in rectification", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { commands: { formatFix: "bun run format:fix" } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("mechanical-formatfix");
  });

  test("AC4: non-TDD verify-scoped failure still enters rectification", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "verify-scoped") {
        return {
          success: false,
          findings: [{ source: "test-runner", severity: "error", message: "scoped test failed" }],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory();
    const config = makeNaxConfig({
      quality: { commands: { lintFix: "bun run lint:fix" } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeNonTddInputs(story, {
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    await plan.run();
    expect(capturedStrategyNames.length).toBeGreaterThan(0);
  });

  test("AC4: autofix enabled → autofix-implementer strategy assembled in rectification", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("autofix-implementer");
  });

  test("AC4: autofix enabled → autofix-test-writer strategy assembled in rectification", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("autofix-test-writer");
  });

  test("AC4: no fix commands + autofix disabled → no mechanical or autofix strategies assembled", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: false } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    // Only the fullSuiteRectifyStrategy should be present (prepended by buildPlanForStrategy for TDD+gate)
    expect(capturedStrategyNames).not.toContain("mechanical-lintfix");
    expect(capturedStrategyNames).not.toContain("mechanical-formatfix");
    expect(capturedStrategyNames).not.toContain("autofix-implementer");
    expect(capturedStrategyNames).not.toContain("autofix-test-writer");
  });

  // Regression: single-session (tdd-simple / test-after / no-test) scoped test
  // failures emit `source: "test-runner"` findings. full-suite-rectify is the only
  // strategy whose appliesTo matches that source. Before the fix it was gated behind
  // TDD / per-story regression, so a single-session scoped failure had NO matching
  // strategy and the cycle exited "no-strategy" at iteration 0 — the story failed
  // without one fix attempt. With autofix disabled and no fix commands, the ONLY
  // strategy that should remain is full-suite-rectify.
  test("regression: single-session + verifyScoped phase → full-suite-rectify assembled (was no-strategy)", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "verify-scoped") {
        return {
          success: false,
          findings: [
            { source: "test-runner", severity: "error", category: "failed-test", message: "scoped test failed" },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory();
    const config = makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: false } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeNonTddInputs(story, {
      verifyScoped: { workdir: "/tmp/test", storyId: story.id },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    await plan.run();
    // autofix disabled + no fix commands → full-suite-rectify is the ONLY
    // assemblable strategy. Exact-set assertion guards against an accidental
    // extra strategy slipping in.
    expect(capturedStrategyNames).toEqual(["full-suite-rectify"]);
  });

  // Negative guard: a single-session plan with NO verify-scoped phase and deferred
  // regression must NOT load full-suite-rectify — there is no phase that can emit
  // test-runner findings, so the strategy would be dead weight. The cycle is driven
  // by a lint-check failure (mechanical-lintfix matches) to ensure runFixCycle runs.
  test("single-session without verifyScoped phase → full-suite-rectify NOT assembled", async () => {
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "lint-check") {
        return { success: false, findings: [{ source: "lint", severity: "error", message: "lint failed" }] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory();
    const config = makeNaxConfig({
      quality: { commands: { lintFix: "bun run lint:fix" }, autofix: { enabled: false } },
      execution: { regressionGate: { mode: "deferred" }, rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeNonTddInputs(story, {
      lintCheck: { workdir: "/tmp/test", storyId: story.id },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("mechanical-lintfix");
    expect(capturedStrategyNames).not.toContain("full-suite-rectify");
  });

  // No-regression guard: three-session TDD must STILL load full-suite-rectify
  // exactly as before (the fix only widens single-session, never narrows TDD).
  test("no-regression: three-session TDD still assembles full-suite-rectify", async () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: false } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
    });
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNames).toContain("full-suite-rectify");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC1: triage scope routes NBF strategies by fixTarget
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC1: triage scope NBF strategy assembly (US-006)", () => {
  let capturedStrategyNamesByCall: string[][] = [];
  let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let origRollbackSpawn: typeof _rollbackDeps.spawn;
  let origRollbackAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
  let runtime: NaxRuntime;

  beforeEach(() => {
    capturedStrategyNamesByCall = [];
    origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    origCallOp = _storyOrchestratorDeps.callOp;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    origRollbackSpawn = _rollbackDeps.spawn;
    origRollbackAutoCommit = _rollbackDeps.autoCommitIfDirty;

    _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
    // captureSnapshotRef uses _rollbackDeps.spawn for git rev-parse HEAD.
    _rollbackDeps.autoCommitIfDirty = mock(async () => {});
    _rollbackDeps.spawn = mock((_cmd: string[], _opts: unknown) => ({
      stdout: new Response("abc1234\n").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    })) as typeof _rollbackDeps.spawn;
    // Mock callOp: adversarial-review passes with advisory findings so NBF fires,
    // verifier passes so adversarial-review actually runs (it sits AFTER verifier
    // in canonical order), and full-suite-gate fails so the main rectification cycle
    // has findings to consume.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "adversarial-review",
              severity: "info",
              category: "test-gap",
              message: "advisory gap",
              fixTarget: "test",
            },
          ],
        };
      }
      if (op.name === "full-suite-gate") {
        return {
          success: false,
          findings: [{ source: "test-runner", severity: "error", message: "test failed" }],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = mock(async (cycle: { strategies: Array<{ name: string }> }) => {
      capturedStrategyNamesByCall.push(cycle.strategies.map((s) => s.name));
      return { iterations: [], finalFindings: [], exitReason: "no-strategy" as const, costUsd: 0 };
    }) as typeof _storyOrchestratorDeps.runFixCycle;
  });

  afterEach(async () => {
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    _rollbackDeps.spawn = origRollbackSpawn;
    _rollbackDeps.autoCommitIfDirty = origRollbackAutoCommit;
    await runtime?.close();
  });

  // The NBF call is the LAST runFixCycle invocation; any subsequent runFixCycle
  // calls come from post-rectification-resume retries, not NBF. NBF strategies
  // are distinguished by their fixTarget-routed composition (claimAdversarialSource
  // / disableBlanketAdversarial), not by name overlap. For AC1 we only need to
  // assert name membership on the LAST call (which is NBF when NBF fires).
  function lastCaptured(): string[] {
    return capturedStrategyNamesByCall[capturedStrategyNamesByCall.length - 1] ?? [];
  }

  function makeCtxWithRuntime(config = makeNaxConfig()) {
    runtime = makeTestRuntime({ config });
    return makeMockCallContext({ runtime });
  }

  function withTriageNbf(extra: Record<string, unknown> = {}): ReturnType<typeof makeNaxConfig> {
    return makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
          nonBlockingFix: {
            enabled: true,
            scope: "triage",
            regressionAttempts: 1,
            verifierGuard: true,
            ...extra,
          },
        },
      },
    });
  }

  function withNbfScope(scope: "source" | "both" | "triage"): ReturnType<typeof makeNaxConfig> {
    return makeNaxConfig({
      quality: { commands: {}, autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
          nonBlockingFix: { enabled: true, scope, regressionAttempts: 1, verifierGuard: true },
        },
      },
    });
  }

  test("AC1: NBF scope=triage assembles autofix-implementer, autofix-test-writer, full-suite-rectify", async () => {
    const story = makeStory({ attempts: 1 });
    const config = withTriageNbf();
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    // NBF is the LAST runFixCycle call (after main rect + post-rectification-resume).
    expect(capturedStrategyNamesByCall.length).toBeGreaterThanOrEqual(2);
    const nbfNames = lastCaptured();
    expect(nbfNames).toContain("autofix-implementer");
    expect(nbfNames).toContain("autofix-test-writer");
    expect(nbfNames).toContain("full-suite-rectify");
  });

  test("AC1: NBF scope=triage does NOT regress — scope=both still assembles the same three", async () => {
    const story = makeStory({ attempts: 1 });
    const config = withNbfScope("both");
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNamesByCall.length).toBeGreaterThanOrEqual(2);
    const nbfNames = lastCaptured();
    expect(nbfNames).toContain("autofix-implementer");
    expect(nbfNames).toContain("autofix-test-writer");
    expect(nbfNames).toContain("full-suite-rectify");
  });

  test("AC1: NBF scope=source still assembles only autofix-implementer + full-suite-rectify", async () => {
    // This test overrides the shared callOp mock so the main loop completes
    // successfully (gate passes, verifier passes, adversarial-review produces advisory
    // findings). That lets NBF fire, which is the call whose strategy composition we
    // actually want to inspect. With full-suite-gate failing (the shared mock), the
    // main loop short-circuits before adversarial-review runs, so NBF never fires.
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { name: string }) => {
      if (op.name === "adversarial-review") {
        return {
          success: true,
          passed: true,
          advisoryFindings: [
            {
              source: "adversarial-review",
              severity: "info",
              category: "test-gap",
              message: "advisory gap",
              fixTarget: "test",
            },
          ],
        };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const story = makeStory({ attempts: 1 });
    const config = withNbfScope("source");
    const ctx = makeCtxWithRuntime(config);
    const inputs = makeTddRetryInputs(story, {
      adversarialReview: {
        story,
        adversarialConfig: config.review.adversarial!,
        mode: config.review.adversarial!.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
    expect(capturedStrategyNamesByCall.length).toBeGreaterThanOrEqual(1);
    // NBF is the only runFixCycle call (no gate failure → no main rectification).
    // For scope:source, NBF assembles implementer + full-suite-rectify, never test-writer.
    const nbfNames = capturedStrategyNamesByCall[0] ?? [];
    expect(nbfNames).toContain("autofix-implementer");
    expect(nbfNames).toContain("full-suite-rectify");
    expect(nbfNames).not.toContain("autofix-test-writer");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC2/AC3/AC4: triage strategy set routes findings by fixTarget
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC2/AC3/AC4: triage strategy predicate behavior", () => {
  // We don't drive these through plan.run() — that mixes too many moving parts.
  // The triage strategy set is determined by buildPlanForStrategy's nbf branch;
  // we inspect the strategies it would assemble by intercepting the call to
  // addNonBlockingFix via the underlying strategy factories.
  //
  // The factories are pure; the predicates are deterministic. By constructing
  // the same strategies the NBF branch would build for triage and exercising
  // each strategy's appliesTo against the AC's findings, we prove the branch
  // routes correctly.

  function makeFinding(overrides: Record<string, unknown> = {}): import("@/findings").Finding {
    return {
      source: "lint",
      severity: "error",
      category: "lint-error",
      message: "msg",
      fixTarget: "source",
      ...overrides,
    };
  }

  test("AC2: triage scope → implementer.appliesTo=true and test-writer.appliesTo=false for adversarial source finding", () => {
    // The triage NBF branch builds the implementer with claimAdversarialSource and
    // the test-writer with disableBlanketAdversarial. Mirror those option shapes here.
    const implementer = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink(), {
      claimAdversarialSource: true,
    });
    const testWriter = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink(), {
      disableBlanketAdversarial: true,
    });
    const finding = makeFinding({ source: "adversarial-review", fixTarget: "source" });
    expect(implementer.appliesTo(finding)).toBe(true);
    expect(testWriter.appliesTo(finding)).toBe(false);
  });

  test("AC3: triage scope → test-writer.appliesTo=true and implementer.appliesTo=false for adversarial test finding", () => {
    const implementer = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink(), {
      claimAdversarialSource: true,
    });
    const testWriter = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink(), {
      disableBlanketAdversarial: true,
    });
    const finding = makeFinding({ source: "adversarial-review", fixTarget: "test" });
    expect(testWriter.appliesTo(finding)).toBe(true);
    expect(implementer.appliesTo(finding)).toBe(false);
  });

  test("AC4: triage scope → test-writer.appliesTo=true for advisory convention finding with fixTarget=test", () => {
    const testWriter = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink(), {
      disableBlanketAdversarial: true,
    });
    const finding = makeFinding({
      source: "adversarial-review",
      category: "convention",
      fixTarget: "test",
    });
    expect(testWriter.appliesTo(finding)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC5/AC6: default-preserving factory options preserve existing behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC5/AC6: blocking three-session set unchanged", () => {
  test("AC6: blocking three-session set → test-writer.appliesTo=true and implementer.appliesTo=false for adversarial source finding", () => {
    // The blocking three-session set is built by buildPlanForStrategy with NO
    // includeAdversarialReview on the implementer (per build-plan-for-strategy.ts:188-191)
    // and the test-writer with default opts (blanket adversarial clause preserved).
    // Mirror those option shapes here.
    const implementer = makeAutofixImplementerStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink());
    const testWriter = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink());
    const finding: import("@/findings").Finding = {
      source: "adversarial-review",
      severity: "warning",
      category: "input",
      message: "advisory finding",
      fixTarget: "source",
    };
    expect(testWriter.appliesTo(finding)).toBe(true);
    expect(implementer.appliesTo(finding)).toBe(false);
  });

  test("AC5: default makeAutofixTestWriterStrategy still claims adversarial source finding (preserves blanket behaviour)", () => {
    const testWriter = makeAutofixTestWriterStrategy(makeStory(), makeNaxConfig(), makeDeclarationSink());
    const finding: import("@/findings").Finding = {
      source: "adversarial-review",
      severity: "warning",
      category: "input",
      message: "advisory finding",
      fixTarget: "source",
    };
    expect(testWriter.appliesTo(finding)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical phase ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — canonical phase ordering", () => {
  test("full TDD fresh run phases appear in canonical order", async () => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig({ review: { enabled: true, checks: ["typecheck", "lint", "test", "build"] as any } });
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toEqual(["test-writer", "greenfield-gate", "implementer", "full-suite-gate", "verifier"]);
  });
});
