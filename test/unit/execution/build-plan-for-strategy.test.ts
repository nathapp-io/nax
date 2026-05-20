/**
 * Tests for buildPlanForStrategy — AC#4 refactor.
 *
 * buildPlanForStrategy now returns an ExecutionPlan instead of a PlanForStrategy boolean-bag.
 * Fresh/retry detection is derived from story.attempts and story.priorFailures — not from
 * an external isFreshRun flag.
 *
 * Use plan.phaseNames() to inspect the set of included phases.
 */
import { describe, expect, test } from "bun:test";
import type { TestStrategy } from "@/config/schema-types";
import { buildPlanForStrategy, ExecutionPlan } from "@/execution";
import type { PlanInputs } from "@/execution";
import type { UserStory } from "@/prd/types";
import {
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeStory,
} from "@test/helpers";

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

function makeSemanticReviewInput(story: UserStory): import("@/operations").SemanticReviewInput {
  return {
    story: { id: story.id, title: story.title, description: story.description, acceptanceCriteria: story.acceptanceCriteria },
    workdir: "/tmp/test",
    semanticConfig: { enabled: true, checks: ["semantic"] } as any,
    mode: "embedded",
  };
}

function makeAdversarialReviewInput(story: UserStory): import("@/operations").AdversarialReviewInput {
  return {
    story: { id: story.id, title: story.title, description: story.description, acceptanceCriteria: story.acceptanceCriteria },
    adversarialConfig: { enabled: true, checks: ["adversarial"] } as any,
    mode: "embedded",
  };
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

function withReviewChecks(checks: Array<"semantic" | "adversarial">) {
  return makeNaxConfig({
    review: {
      enabled: true,
      checks: ["typecheck", "lint", "test", "build", ...checks] as any,
    },
  });
}

function withRectification(enabled: boolean) {
  return makeNaxConfig({
    execution: {
      rectification: enabled ? { enabled: true, maxRetries: 2 } : { enabled: false },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Return type
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — returns ExecutionPlan", () => {
  test("returns an ExecutionPlan instance", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan).toBeInstanceOf(ExecutionPlan);
  });

  test("plan has phaseNames() method", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(typeof plan.phaseNames).toBe("function");
    expect(Array.isArray(plan.phaseNames())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fresh vs retry detection — derived from story.attempts + priorFailures
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — fresh vs retry detection", () => {
  test("story.attempts=0 (fresh) includes test-writer and greenfield-gate for TDD", () => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names).toContain("test-writer");
    expect(names).toContain("greenfield-gate");
  });

  test("story.attempts=0 full TDD fresh run includes all core phases", () => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toEqual(["test-writer", "greenfield-gate", "implementer", "full-suite-gate", "verifier"]);
  });

  test("story.attempts=1 (retry) omits test-writer and greenfield-gate for TDD", () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddRetryInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names).not.toContain("test-writer");
    expect(names).not.toContain("greenfield-gate");
  });

  test("story.attempts=1 retry includes implementer, full-suite-gate, verifier", () => {
    const story = makeStory({ attempts: 1 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddRetryInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toEqual(["implementer", "full-suite-gate", "verifier"]);
  });

  test("story with priorFailures stage=review is treated as retry", () => {
    const story = makeStory({
      attempts: 0,
      priorFailures: [{ attempt: 0, modelTier: "fast", stage: "review", summary: "review failed", timestamp: new Date().toISOString() }],
    });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddRetryInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names).not.toContain("test-writer");
    expect(names).not.toContain("greenfield-gate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-TDD single-session
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — non-TDD single-session", () => {
  test("no-test strategy includes only implementer", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toEqual(["implementer"]);
  });

  test("test-after strategy includes only implementer", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeNonTddInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, "test-after", inputs);
    expect(plan.phaseNames()).toEqual(["implementer"]);
  });

  test("tdd-simple strategy includes only implementer (single-session, no test-writer/verifier)", () => {
    // tdd-simple is a SINGLE-SESSION strategy: one agent writes tests AND
    // implements within the same session. It must NOT trigger the three-session
    // orchestration (no test-writer, greenfield-gate, full-suite-gate, or verifier).
    // See src/metrics/tracker.ts:142-143 for the canonical three-session list.
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story); // even with all inputs available
    const plan = buildPlanForStrategy(ctx, story, config, "tdd-simple", inputs);
    expect(plan.phaseNames()).toEqual(["implementer"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TDD strategy variants
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — three-session TDD strategy variants", () => {
  // tdd-simple is NOT included — it is a single-session strategy that does not
  // dispatch test-writer, full-suite-gate, or verifier slots.
  const tddStrategies: TestStrategy[] = [
    "three-session-tdd",
    "three-session-tdd-lite",
  ];

  test.each(tddStrategies)("%s fresh includes full-suite-gate and verifier", (strategy) => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    const plan = buildPlanForStrategy(ctx, story, config, strategy, inputs);
    const names = plan.phaseNames();
    expect(names).toContain("full-suite-gate");
    expect(names).toContain("verifier");
  });

  test.each(tddStrategies)("%s fresh omits full-suite-gate and verifier when inputs missing", (strategy) => {
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
    const plan = buildPlanForStrategy(ctx, story, config, strategy, inputs);
    const names = plan.phaseNames();
    expect(names).not.toContain("full-suite-gate");
    expect(names).not.toContain("verifier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review phase selection
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — review phase selection", () => {
  test("semantic review included when semantic in checks and input provided", () => {
    const story = makeStory();
    const config = withReviewChecks(["semantic"]);
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: makeImplementerInput(story),
      semanticReview: makeSemanticReviewInput(story),
    });
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toContain("semantic-review");
  });

  test("adversarial review included when adversarial in checks and input provided", () => {
    const story = makeStory();
    const config = withReviewChecks(["adversarial"]);
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: makeImplementerInput(story),
      adversarialReview: makeAdversarialReviewInput(story),
    });
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).toContain("adversarial-review");
  });

  test("both semantic and adversarial included when both in checks and inputs provided", () => {
    const story = makeStory();
    const config = withReviewChecks(["semantic", "adversarial"]);
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: makeImplementerInput(story),
      semanticReview: makeSemanticReviewInput(story),
      adversarialReview: makeAdversarialReviewInput(story),
    });
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    const names = plan.phaseNames();
    expect(names).toContain("semantic-review");
    expect(names).toContain("adversarial-review");
  });

  test("semantic review omitted when review disabled", () => {
    const story = makeStory();
    const config = makeNaxConfig({ review: { enabled: false } });
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: makeImplementerInput(story),
      semanticReview: makeSemanticReviewInput(story),
    });
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).not.toContain("semantic-review");
  });

  test("adversarial review omitted when adversarial not in checks", () => {
    const story = makeStory();
    const config = withReviewChecks(["semantic"]);
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: makeImplementerInput(story),
      adversarialReview: makeAdversarialReviewInput(story),
    });
    const plan = buildPlanForStrategy(ctx, story, config, "no-test", inputs);
    expect(plan.phaseNames()).not.toContain("adversarial-review");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rectification
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — rectification", () => {
  test("rectification appears last when enabled and inputs.rectification provided", () => {
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
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names[names.length - 1]).toBe("rectification");
  });

  test("rectification omitted when not enabled in config", () => {
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
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).not.toContain("rectification");
  });

  test("rectification omitted when inputs.rectification is undefined even if config enabled", () => {
    const story = makeStory({ attempts: 0 });
    const config = withRectification(true);
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story);
    // No rectification in inputs
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).not.toContain("rectification");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical phase ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — canonical phase ordering", () => {
  test("full TDD fresh run phases appear in canonical order", () => {
    const story = makeStory({ attempts: 0 });
    const config = withReviewChecks(["semantic", "adversarial"]);
    const ctx = makeMockCallContext();
    const inputs = makeTddFreshInputs(story, {
      semanticReview: makeSemanticReviewInput(story),
      adversarialReview: makeAdversarialReviewInput(story),
    });
    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "verifier",
      "semantic-review",
      "adversarial-review",
    ]);
  });
});
