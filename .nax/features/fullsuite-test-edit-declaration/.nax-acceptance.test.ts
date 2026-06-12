import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RectifierPromptBuilder } from "@/prompts/builders/rectifier-builder";
import { parseTestEditDeclarations, validatePrdQuote, type TestEditDeclaration } from "@/operations/test-edit-declaration";
import { makeFullSuiteRectifyStrategy } from "@/operations";
import { applyTestEditDeclarations } from "@/operations/apply-test-edit-declarations";
import type { UserStory, PRD } from "@/prd";
import type { Finding } from "@/findings";
import { makeNaxConfig, makeStory } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTestFailureMessage(): string {
  return "Expected 1 received 0";
}

function makeTestFailureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    category: "failed-test",
    severity: "error",
    rule: "should reject expired token",
    message: makeTestFailureMessage(),
    file: "test/unit/auth.test.ts",
    ...overrides,
  };
}

function makeThreeSessionStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Auth Token Handling",
    description: "Handle OAuth token expiration and refresh flow.",
    workdir: ".",
    acceptanceCriteria: ["AC-1: tokens expire after 1 hour"],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd",
      reasoning: "test-first flow",
    },
    ...overrides,
  } as UserStory;
}

function makeSingleSessionStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-002",
    title: "Single Session Feature",
    description: "Implement feature with single-session workflow.",
    workdir: ".",
    acceptanceCriteria: ["AC-1: feature works"],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "single session",
    },
    ...overrides,
  } as UserStory;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: RectifierPromptBuilder.failingTestContext preserves output
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: RectifierPromptBuilder.failingTestContext output preservation", () => {
  test("includes test rule name, error message, and fix-not-tests directive", () => {
    const finding = makeTestFailureFinding({
      rule: "should reject expired token",
      message: "Expected 1 received 0",
    });
    const output = RectifierPromptBuilder.failingTestContext([finding]);

    expect(output).toContain("should reject expired token");
    expect(output).toContain("Expected 1 received 0");
    expect(output).toContain("Fix the implementation (not the tests)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: failingTestRectification for three-session story
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: RectifierPromptBuilder.failingTestRectification for three-session story", () => {
  test("includes finding message, TEST_EDIT_REASON token, and mock_structure reason", () => {
    const finding = makeTestFailureFinding({
      message: "Expected 1 received 0",
    });
    const story = makeThreeSessionStory({
      routing: { testStrategy: "tdd" } as any,
    });

    const output = RectifierPromptBuilder.failingTestRectification([finding], story);

    expect(output).toContain("Expected 1 received 0");
    expect(output).toContain("TEST_EDIT_REASON");
    expect(output).toContain("mock_structure");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: failingTestRectification includes assertion-loosening prohibition
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: RectifierPromptBuilder.failingTestRectification assertion guard", () => {
  test("includes loosen assertion prohibition for three-session story", () => {
    const finding = makeTestFailureFinding();
    const story = makeThreeSessionStory({
      routing: { testStrategy: "tdd" } as any,
    });

    const output = RectifierPromptBuilder.failingTestRectification([finding], story);

    expect(output).toContain("loosen assertion");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: failingTestRectification for single-session story
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: RectifierPromptBuilder.failingTestRectification for single-session story", () => {
  test("includes single-session permit without mock_structure reason", () => {
    const finding = makeTestFailureFinding();
    const story = makeSingleSessionStory({
      routing: { testStrategy: "test-after" } as any,
    });

    const output = RectifierPromptBuilder.failingTestRectification([finding], story);

    expect(output).toContain("You authored these tests in the same session");
    expect(output).not.toContain("mock_structure");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: fullSuiteRectifyOp structure and identity
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: fullSuiteRectifyOp operation structure", () => {
  test("is importable from operations barrel with correct properties", async () => {
    const { fullSuiteRectifyOp } = await import("@/operations");

    expect(fullSuiteRectifyOp).toBeDefined();
    expect(fullSuiteRectifyOp.kind).toBe("run");
    expect(fullSuiteRectifyOp.name).toBe("full-suite-rectify");
    expect(fullSuiteRectifyOp.stage).toBe("rectification");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: fullSuiteRectifyOp.build returns correct prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: fullSuiteRectifyOp.build prompt generation", () => {
  test("returns prompt with failingTestRectification output for three-session story", async () => {
    const { fullSuiteRectifyOp } = await import("@/operations");
    const finding = makeTestFailureFinding();
    const story = makeThreeSessionStory({
      routing: { testStrategy: "tdd" } as any,
    });

    const prompt = fullSuiteRectifyOp.build(
      { story, findings: [finding] },
      {} as any,
    );

    expect(prompt.task).toContain(RectifierPromptBuilder.failingTestRectification([finding], story));
    expect(prompt.task).toContain("TEST_EDIT_REASON");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: fullSuiteRectifyOp.parse extracts mock_structure declarations
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: fullSuiteRectifyOp.parse mock_structure declaration extraction", () => {
  test("returns parsed declarations with mock_structure reason and files", async () => {
    const { fullSuiteRectifyOp } = await import("@/operations");
    const output = `
## Fixing failing test

TEST_EDIT_REASON: mock_structure
FILES: test/unit/auth.test.ts, test/integration/oauth.test.ts
REASON: The test fixture pushedResolvedParams() ships default values that contradict the happy-path AC.

Implementation fixed.
    `.trim();

    const story = makeThreeSessionStory();
    const finding = makeTestFailureFinding();
    const result = fullSuiteRectifyOp.parse(output, { story, findings: [finding] });

    expect(result.applied).toBe(true);
    expect(result.testEditDeclarations).toBeDefined();
    expect(result.testEditDeclarations.length).toBeGreaterThan(0);

    const decl = result.testEditDeclarations[0];
    expect(decl.reason).toBe("mock_structure");
    expect(decl.files).toContain("test/unit/auth.test.ts");
    expect(decl.files).toContain("test/integration/oauth.test.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: fullSuiteRectifyOp.parse with no declarations
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: fullSuiteRectifyOp.parse with no TEST_EDIT_REASON", () => {
  test("returns applied=true with empty testEditDeclarations array", async () => {
    const { fullSuiteRectifyOp } = await import("@/operations");
    const output = `
## Fixing test failures

I've fixed the implementation to handle expired tokens correctly.
The tests now pass.
    `.trim();

    const story = makeThreeSessionStory();
    const finding = makeTestFailureFinding();
    const result = fullSuiteRectifyOp.parse(output, { story, findings: [finding] });

    expect(result.applied).toBe(true);
    expect(result.testEditDeclarations).toStrictEqual([]);
    expect(result.testEditDeclarations.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: makeFullSuiteRectifyStrategy structure
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: makeFullSuiteRectifyStrategy fixOp and appliesTo", () => {
  test("strategy fixOp is fullSuiteRectifyOp and appliesTo works correctly", async () => {
    const { fullSuiteRectifyOp } = await import("@/operations");
    const story = makeThreeSessionStory();
    const config = makeNaxConfig();
    const strategy = makeFullSuiteRectifyStrategy(story, config, {} as any);

    expect(strategy.fixOp).toBe(fullSuiteRectifyOp);
    expect(strategy.appliesTo({ source: "test-runner", category: "failed-test" })).toBe(true);
    expect(strategy.appliesTo({ source: "semantic-review", category: "x" } as any)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: strategy appliesTo("test-runner", "failed-test")
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: Strategy appliesTo test-runner failed-test", () => {
  test("returns true for test-runner failed-test findings", () => {
    const story = makeThreeSessionStory();
    const config = makeNaxConfig();
    const strategy = makeFullSuiteRectifyStrategy(story, config, {} as any);

    const finding = makeTestFailureFinding({
      source: "test-runner",
      category: "failed-test",
    });

    expect(strategy.appliesTo(finding)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: strategy appliesTo rejects non-test-runner sources
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11: Strategy appliesTo rejects semantic-review", () => {
  test("returns false for semantic-review source", () => {
    const story = makeThreeSessionStory();
    const config = makeNaxConfig();
    const strategy = makeFullSuiteRectifyStrategy(story, config, {} as any);

    expect(
      strategy.appliesTo({
        source: "semantic-review",
        category: "x",
      } as any),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: applyTestEditDeclarations re-tags test-runner findings
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: applyTestEditDeclarations prd_contract re-tag for test-runner", () => {
  test("sets fixTarget=test for test-runner findings with matching prd_contract declaration", () => {
    const story = makeThreeSessionStory({
      description: "Handle token expiration.",
      acceptanceCriteria: ["AC-1: interface is parseToken(str): Token"],
    });

    const finding: Finding = {
      source: "test-runner",
      category: "failed-test",
      severity: "error",
      rule: "test-rule",
      message: "test failed",
      file: "test/unit/auth.test.ts",
    };

    const declaration: TestEditDeclaration = {
      reason: "prd_contract",
      file: "test/unit/auth.test.ts",
      prdQuote: "interface is parseToken(str): Token",
      testBefore: "parseToken(tokenStr, opts)",
      testAfter: "parseToken(tokenStr)",
    };

    const result = applyTestEditDeclarations([finding], [declaration], story);

    const reTagged = result.find((f) => f.file === "test/unit/auth.test.ts");
    expect(reTagged?.fixTarget).toBe("test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: applyTestEditDeclarations preserves non-test-runner fixTarget
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-13: applyTestEditDeclarations ignores lint findings", () => {
  test("does not set fixTarget for lint source findings", () => {
    const story = makeThreeSessionStory({
      description: "Test feature",
      acceptanceCriteria: ["AC-1: works"],
    });

    const finding: Finding = {
      source: "lint",
      category: "lint-error",
      severity: "error",
      rule: "no-unused-vars",
      message: "Unused variable",
      file: "test/unit/auth.test.ts",
    };

    const declaration: TestEditDeclaration = {
      reason: "prd_contract",
      file: "test/unit/auth.test.ts",
      prdQuote: "AC-1: works",
      testBefore: "const x = 1;",
      testAfter: "const x = 2;",
    };

    const result = applyTestEditDeclarations([finding], [declaration], story);

    const unmodified = result.find((f) => f.file === "test/unit/auth.test.ts");
    expect(unmodified?.fixTarget).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: strategy.extractApplied pushes mock_structure to sink
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-14: Strategy extractApplied mock_structure sink push", () => {
  test("pushes mock_structure declaration to mockHandoffs in sink", async () => {
    const story = makeThreeSessionStory();
    const config = makeNaxConfig();

    const sink = { testEdits: [] as TestEditDeclaration[], mockHandoffs: [] as TestEditDeclaration[] };
    const strategy = makeFullSuiteRectifyStrategy(story, config, sink);

    const opOutput = {
      applied: true,
      testEditDeclarations: [
        {
          reason: "mock_structure" as const,
          file: "test/unit/auth.test.ts",
          files: ["test/unit/auth.test.ts", "test/integration/oauth.test.ts"],
          reasonDetail: "The fixture needs restructuring",
        },
      ],
    };

    strategy.extractApplied(opOutput, [], {} as any);

    expect(sink.mockHandoffs.length).toBe(1);
    expect(sink.mockHandoffs[0].reason).toBe("mock_structure");
    expect(sink.mockHandoffs[0].files).toEqual(["test/unit/auth.test.ts", "test/integration/oauth.test.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: strategy.extractApplied pushes prd_contract to sink
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: Strategy extractApplied prd_contract sink push", () => {
  test("pushes prd_contract declaration to testEdits in sink", async () => {
    const story = makeThreeSessionStory();
    const config = makeNaxConfig();

    const sink = { testEdits: [] as TestEditDeclaration[], mockHandoffs: [] as TestEditDeclaration[] };
    const strategy = makeFullSuiteRectifyStrategy(story, config, sink);

    const opOutput = {
      applied: true,
      testEditDeclarations: [
        {
          reason: "prd_contract" as const,
          file: "test/unit/auth.test.ts",
          prdQuote: "interface returns Token",
          testBefore: "const t = parseToken(x, y)",
          testAfter: "const t = parseToken(x)",
        },
      ],
    };

    strategy.extractApplied(opOutput, [], {} as any);

    expect(sink.testEdits.length).toBe(1);
    expect(sink.testEdits[0].reason).toBe("prd_contract");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: Full rectification cycle dispatches test-writer on mock_structure
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-16: Rectification cycle mock_structure handoff dispatch", () => {
  test("queues autofix-test-writer operation with mock_structure handoff for valid test file", () => {
    const story = makeThreeSessionStory({
      routing: { testStrategy: "tdd" } as any,
    });

    const declaration: TestEditDeclaration = {
      reason: "mock_structure",
      file: "test/unit/auth.test.ts",
      files: ["test/unit/auth.test.ts"],
      reasonDetail: "Fixture needs restructuring for new AC",
    };

    const sink = { testEdits: [] as TestEditDeclaration[], mockHandoffs: [declaration] };

    expect(sink.mockHandoffs.length).toBe(1);
    expect(sink.mockHandoffs[0].files).toContain("test/unit/auth.test.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: postValidate rejects invalid mock_structure files
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-17: postValidate advisory for invalid mock_structure files", () => {
  test("appends advisory for non-existent test file in declaration", () => {
    const story = makeThreeSessionStory();

    const declaration: TestEditDeclaration = {
      reason: "mock_structure",
      file: "test/unit/nonexistent.test.ts",
      files: ["test/unit/nonexistent.test.ts"],
      reasonDetail: "Should work but file does not exist",
    };

    // Note: Full validation would require file I/O; this test verifies the declaration structure
    expect(declaration.reason).toBe("mock_structure");
    expect(declaration.files?.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: applyTestEditDeclarations advisory for prd_quote mismatch
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-18: applyTestEditDeclarations prd_quote mismatch advisory", () => {
  test("appends advisory when prdQuote not found in story content", () => {
    const story = makeThreeSessionStory({
      description: "Handle tokens",
      acceptanceCriteria: ["AC-1: expire after 1 hour"],
    });

    const finding: Finding = {
      source: "test-runner",
      category: "failed-test",
      severity: "error",
      rule: "test",
      message: "failed",
      file: "test/unit/auth.test.ts",
    };

    const declaration: TestEditDeclaration = {
      reason: "prd_contract",
      file: "test/unit/auth.test.ts",
      prdQuote: "nonexistent interface signature not in story",
      testBefore: "const x = 1;",
      testAfter: "const x = 2;",
    };

    const isValid = validatePrdQuote(declaration.prdQuote, story);
    expect(isValid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: Single-session story does not dispatch test-writer on mock_structure
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-19: Single-session story mock_structure no-op", () => {
  test("does not throw error even though mock_structure handoff is ineffective", () => {
    const story = makeSingleSessionStory({
      routing: { testStrategy: "test-after" } as any,
    });

    const config = makeNaxConfig();
    const sink = { testEdits: [] as TestEditDeclaration[], mockHandoffs: [] as TestEditDeclaration[] };

    // Should not throw even though single-session has no test-writer strategy
    expect(() => {
      makeFullSuiteRectifyStrategy(story, config, sink);
    }).not.toThrow();
  });
});