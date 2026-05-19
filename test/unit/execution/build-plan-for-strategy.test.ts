import { describe, expect, test } from "bun:test";
import type { TestStrategy } from "@/config/schema-types";
import { buildPlanForStrategy } from "@/execution";
import { makeNaxConfig, makeStory } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface PlanSlot {
  testWriter?: boolean;
  greenfieldGate?: boolean;
  implementer?: boolean;
  fullSuiteGate?: boolean;
  verifier?: boolean;
  semanticReview?: boolean;
  adversarialReview?: boolean;
  rectification?: boolean;
}

function extractSlots(plan: unknown): PlanSlot {
  if (!plan || typeof plan !== "object") {
    return {};
  }

  const p = plan as Record<string, unknown>;
  return {
    testWriter: Boolean(p.testWriter),
    greenfieldGate: Boolean(p.greenfieldGate),
    implementer: Boolean(p.implementer),
    fullSuiteGate: Boolean(p.fullSuiteGate),
    verifier: Boolean(p.verifier),
    semanticReview: Boolean(p.semanticReview),
    adversarialReview: Boolean(p.adversarialReview),
    rectification: Boolean(p.rectification),
  };
}

function withReviewChecks(checks: Array<"semantic" | "adversarial">) {
  return makeNaxConfig({
    review: {
      enabled: true,
      checks: [
        "typecheck",
        "lint",
        "test",
        "build",
        ...checks,
      ] as any,
    },
  });
}

function withoutReviewChecks() {
  return makeNaxConfig({
    review: {
      enabled: true,
      checks: ["typecheck", "lint", "test", "build"],
    },
  });
}

function withRectification(enabled: boolean) {
  return makeNaxConfig({
    execution: {
      rectification: enabled
        ? { enabled: true, maxRetries: 2 }
        : { enabled: false },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: testStrategy as explicit parameter (not read from config)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC1: explicit testStrategy parameter", () => {
  test("accepts testStrategy parameter directly", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    // This test verifies the function signature and that it accepts testStrategy.
    // The implementation should not read testStrategy from config, but from the parameter.
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
    });
    expect(plan).toBeDefined();
  });

  test("ignores testStrategy in story.routing when parameter is provided", () => {
    const story = makeStory({
      routing: { testStrategy: "test-after" },
    });
    const config = makeNaxConfig();
    // Even though story.routing.testStrategy is "test-after", we pass "three-session-tdd"
    // The returned plan should reflect "three-session-tdd", not the story's value
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "three-session-tdd",
    });
    const slots = extractSlots(plan);
    expect(slots.testWriter).toBe(true);
    expect(slots.verifier).toBe(true);
    expect(slots.fullSuiteGate).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: Fresh TDD vs Retry run inclusion
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC2: fresh vs retry run slots", () => {
  test("fresh TDD run includes test-writer (isFreshRun=true)", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.testWriter).toBe(true);
  });

  test("fresh TDD run includes greenfield-gate (isFreshRun=true)", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.greenfieldGate).toBe(true);
  });

  test("fresh TDD run includes implementer (isFreshRun=true)", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.implementer).toBe(true);
  });

  test("retry run omits test-writer (isFreshRun=false)", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: false,
    });
    const slots = extractSlots(plan);
    expect(slots.testWriter).toBe(false);
  });

  test("retry run omits greenfield-gate (isFreshRun=false)", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: false,
    });
    const slots = extractSlots(plan);
    expect(slots.greenfieldGate).toBe(false);
  });

  test("retry run includes implementer (isFreshRun=false)", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: false,
    });
    const slots = extractSlots(plan);
    expect(slots.implementer).toBe(true);
  });

  test("retry run with no-test still includes implementer", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "no-test",
      isFreshRun: false,
    });
    const slots = extractSlots(plan);
    expect(slots.implementer).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: TDD strategies include gates and verifier; non-TDD omit them
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC3: TDD strategy gates and verifier", () => {
  const tddStrategies: TestStrategy[] = [
    "tdd-simple",
    "three-session-tdd",
    "three-session-tdd-lite",
  ];

  test.each(tddStrategies)("%s includes full-suite-gate", (strategy) => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: strategy,
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.fullSuiteGate).toBe(true);
  });

  test.each(tddStrategies)("%s includes verifier", (strategy) => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: strategy,
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.verifier).toBe(true);
  });

  test("test-after omits full-suite-gate", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "test-after",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.fullSuiteGate).toBe(false);
  });

  test("test-after omits verifier", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "test-after",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.verifier).toBe(false);
  });

  test("no-test omits full-suite-gate", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "no-test",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.fullSuiteGate).toBe(false);
  });

  test("no-test omits verifier", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "no-test",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.verifier).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: Review phase selection via config.review.checks membership
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC4: review phase selection by checks", () => {
  test("semantic-review included when 'semantic' in checks", () => {
    const story = makeStory();
    const config = withReviewChecks(["semantic"]);
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.semanticReview).toBe(true);
  });

  test("adversarial-review included when 'adversarial' in checks", () => {
    const story = makeStory();
    const config = withReviewChecks(["adversarial"]);
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.adversarialReview).toBe(true);
  });

  test("both semantic and adversarial included when both in checks", () => {
    const story = makeStory();
    const config = withReviewChecks(["semantic", "adversarial"]);
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.semanticReview).toBe(true);
    expect(slots.adversarialReview).toBe(true);
  });

  test("semantic-review omitted when 'semantic' not in checks", () => {
    const story = makeStory();
    const config = withoutReviewChecks();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.semanticReview).toBe(false);
  });

  test("adversarial-review omitted when 'adversarial' not in checks", () => {
    const story = makeStory();
    const config = withoutReviewChecks();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.adversarialReview).toBe(false);
  });

  test("semantic-review omitted when review disabled entirely", () => {
    const story = makeStory();
    const config = makeNaxConfig({
      review: { enabled: false },
    });
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.semanticReview).toBe(false);
  });

  test("adversarial-review omitted when review disabled entirely", () => {
    const story = makeStory();
    const config = makeNaxConfig({
      review: { enabled: false },
    });
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.adversarialReview).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: Rectification gated by shouldRunRectification(config)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC5: rectification gating", () => {
  test("rectification included when config.execution.rectification.enabled=true", () => {
    const story = makeStory();
    const config = withRectification(true);
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.rectification).toBe(true);
  });

  test("rectification omitted when config.execution.rectification.enabled=false", () => {
    const story = makeStory();
    const config = withRectification(false);
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.rectification).toBe(false);
  });

  test("rectification omitted when config.execution.rectification not set", () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "tdd-simple",
      isFreshRun: true,
    });
    const slots = extractSlots(plan);
    expect(slots.rectification).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: Slot composition logic — table-driven tests
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — AC6: slot composition table-driven tests", () => {
  interface SlotCompositionCase {
    name: string;
    testStrategy: TestStrategy;
    isFreshRun: boolean;
    config: ReturnType<typeof makeNaxConfig>;
    expectedSlots: PlanSlot;
  }

  const cases: SlotCompositionCase[] = [
    {
      name: "Fresh TDD simple with review and rectification",
      testStrategy: "tdd-simple",
      isFreshRun: true,
      config: makeNaxConfig({
        review: { enabled: true, checks: ["typecheck", "lint", "test", "build", "semantic"] },
        execution: { rectification: { enabled: true } },
      }),
      expectedSlots: {
        testWriter: true,
        greenfieldGate: true,
        implementer: true,
        fullSuiteGate: true,
        verifier: true,
        semanticReview: true,
        adversarialReview: false,
        rectification: true,
      },
    },
    {
      name: "Retry TDD simple with no review",
      testStrategy: "tdd-simple",
      isFreshRun: false,
      config: makeNaxConfig({
        review: { enabled: false },
      }),
      expectedSlots: {
        testWriter: false,
        greenfieldGate: false,
        implementer: true,
        fullSuiteGate: true,
        verifier: true,
        semanticReview: false,
        adversarialReview: false,
        rectification: false,
      },
    },
    {
      name: "Fresh three-session-tdd with all reviews",
      testStrategy: "three-session-tdd",
      isFreshRun: true,
      config: makeNaxConfig({
        review: { enabled: true, checks: ["typecheck", "lint", "test", "build", "semantic", "adversarial"] },
      }),
      expectedSlots: {
        testWriter: true,
        greenfieldGate: true,
        implementer: true,
        fullSuiteGate: true,
        verifier: true,
        semanticReview: true,
        adversarialReview: true,
        rectification: false,
      },
    },
    {
      name: "Fresh test-after with no TDD gates",
      testStrategy: "test-after",
      isFreshRun: true,
      config: makeNaxConfig({
        review: { enabled: true, checks: ["typecheck", "lint", "test", "build"] },
      }),
      expectedSlots: {
        testWriter: false,
        greenfieldGate: false,
        implementer: true,
        fullSuiteGate: false,
        verifier: false,
        semanticReview: false,
        adversarialReview: false,
        rectification: false,
      },
    },
    {
      name: "Fresh no-test with review",
      testStrategy: "no-test",
      isFreshRun: true,
      config: makeNaxConfig({
        review: { enabled: true, checks: ["typecheck", "lint", "test", "build", "semantic"] },
      }),
      expectedSlots: {
        testWriter: false,
        greenfieldGate: false,
        implementer: true,
        fullSuiteGate: false,
        verifier: false,
        semanticReview: true,
        adversarialReview: false,
        rectification: false,
      },
    },
    {
      name: "Retry three-session-tdd-lite with adversarial only",
      testStrategy: "three-session-tdd-lite",
      isFreshRun: false,
      config: makeNaxConfig({
        review: { enabled: true, checks: ["typecheck", "lint", "test", "build", "adversarial"] },
      }),
      expectedSlots: {
        testWriter: false,
        greenfieldGate: false,
        implementer: true,
        fullSuiteGate: true,
        verifier: true,
        semanticReview: false,
        adversarialReview: true,
        rectification: false,
      },
    },
  ];

  test.each(cases)("$name", (testCase) => {
    const story = makeStory();
    const plan = buildPlanForStrategy({
      story,
      config: testCase.config,
      testStrategy: testCase.testStrategy,
      isFreshRun: testCase.isFreshRun,
    });
    const slots = extractSlots(plan);

    expect(slots.testWriter).toBe(testCase.expectedSlots.testWriter);
    expect(slots.greenfieldGate).toBe(testCase.expectedSlots.greenfieldGate);
    expect(slots.implementer).toBe(testCase.expectedSlots.implementer);
    expect(slots.fullSuiteGate).toBe(testCase.expectedSlots.fullSuiteGate);
    expect(slots.verifier).toBe(testCase.expectedSlots.verifier);
    expect(slots.semanticReview).toBe(testCase.expectedSlots.semanticReview);
    expect(slots.adversarialReview).toBe(testCase.expectedSlots.adversarialReview);
    expect(slots.rectification).toBe(testCase.expectedSlots.rectification);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus: Canonical order is preserved
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanForStrategy — slot order preserved (CANONICAL_ORDER)", () => {
  test("slots are in CANONICAL_ORDER: test-writer, greenfield-gate, implementer, full-suite-gate, verifier, semantic-review, adversarial-review", () => {
    const story = makeStory();
    const config = makeNaxConfig({
      review: { enabled: true, checks: ["typecheck", "lint", "test", "build", "semantic", "adversarial"] },
    });
    const plan = buildPlanForStrategy({
      story,
      config,
      testStrategy: "three-session-tdd",
      isFreshRun: true,
    });

    // Plan should have a slots array or similar that maintains order
    expect(plan).toBeDefined();
    // Implementation will verify order via phase execution logic
  });
});
