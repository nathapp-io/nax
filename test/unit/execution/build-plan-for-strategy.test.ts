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
import type { UserStory } from "@/prd/types";
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
