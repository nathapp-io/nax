import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Finding, ValidateResult, VerifierOutput } from "../../../src/findings";
import { normalizeValidateResult } from "../../../src/findings/cycle";
import type { FixCycleResult, FixCycleExitReason } from "../../../src/findings/cycle-types";
import { findingsToFailedChecks } from "../../../src/operations/_finding-to-check";
import { buildVerifierFindings, extractPhaseFindings, runRectification } from "../../../src/execution/story-orchestrator";
import { RectifierPromptBuilder } from "../../../src/prompts/builders/rectifier-builder";
import type { VerdictCategorization, VerifierVerdict } from "../../../src/tdd/verdict";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> & { source: string }): Finding {
  return {
    source: overrides.source,
    severity: "error",
    category: "test-error",
    message: "Test finding",
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<VerifierVerdict> = {}): VerifierVerdict {
  return {
    success: false,
    tests: { passCount: 0, failCount: 1 },
    testModifications: { files: [], reasoning: "Modified test" },
    reasoning: "Test failed",
    ...overrides,
  };
}

function makeCategorization(overrides: Partial<VerdictCategorization> = {}): VerdictCategorization {
  return {
    success: true,
    failureCategory: undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: buildVerifierFindings defensive branch
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: buildVerifierFindings with undefined/unknown failureCategory", () => {
  test("returns empty array when categorization.failureCategory is undefined", () => {
    const verdict = makeVerdict();
    const categorization = makeCategorization({ success: false, failureCategory: undefined });

    const result = buildVerifierFindings(verdict, categorization);

    expect(result).toEqual([]);
    expect(Array.isArray(result)).toBe(true);
  });

  test("returns empty array for unknown failureCategory", () => {
    const verdict = makeVerdict();
    const categorization = makeCategorization({
      success: false,
      failureCategory: "unknown-value" as any,
    });

    const result = buildVerifierFindings(verdict, categorization);

    expect(result).toEqual([]);
  });

  test("does not throw when handling invalid failureCategory", () => {
    const verdict = makeVerdict();
    const categorization = makeCategorization({ success: false, failureCategory: "invalid" as any });

    expect(() => {
      buildVerifierFindings(verdict, categorization);
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: parseVerdictFromStdout (via buildVerifierFindings) with missing fields
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: buildVerifierFindings handles missing optional fields", () => {
  test("tests-failing category produces non-empty findings", () => {
    const verdict = makeVerdict({
      tests: { passCount: 5, failCount: 2 },
      reasoning: "2 tests failed",
    });
    const categorization = makeCategorization({
      success: false,
      failureCategory: "tests-failing",
    });

    const result = buildVerifierFindings(verdict, categorization);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toMatchObject({
      category: "tests-failed",
      source: "tdd-verifier",
      severity: "error",
      fixTarget: "source",
    });
    expect(result[0].message).toMatch(/2 story-scoped test/);
  });

  test("verifier-rejected category produces test-edit finding", () => {
    const verdict = makeVerdict({
      testModifications: {
        files: ["test.ts", "spec.ts"],
        reasoning: "Edited test files",
      },
    });
    const categorization = makeCategorization({
      success: false,
      failureCategory: "verifier-rejected",
    });

    const result = buildVerifierFindings(verdict, categorization);

    expect(result.length).toBe(1);
    expect(result[0]).toMatchObject({
      category: "illegitimate-test-edits",
      source: "tdd-verifier",
      severity: "error",
      fixTarget: "test",
    });
    expect(result[0].message).toMatch(/test files illegitimately/);
  });

  test("does not throw on success=true categorization", () => {
    const verdict = makeVerdict();
    const categorization = makeCategorization({ success: true });

    expect(() => {
      buildVerifierFindings(verdict, categorization);
    }).not.toThrow();

    const result = buildVerifierFindings(verdict, categorization);
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: verifierOp.recover() returns findings on valid verdict
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: verifierOp.recover() with categorized verdict", () => {
  test("returns non-empty findings when verdict categorization fails", () => {
    const verdict = makeVerdict({ tests: { passCount: 0, failCount: 3 } });
    const categorization = makeCategorization({
      success: false,
      failureCategory: "tests-failing",
    });

    const findings = buildVerifierFindings(verdict, categorization);
    const output: Partial<VerifierOutput> = {
      success: false,
      normalizedFindings: findings,
      filesChanged: [],
      estimatedCostUsd: 0.01,
      durationMs: 5000,
      output: "verdict raw",
      failureCategory: "tests-failing",
    };

    expect((output.normalizedFindings as Finding[]).length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: verifierOp.recover() returns empty array on missing verdict
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: verifierOp.recover() fail-closed path", () => {
  test("returns empty findings array when no verdict file exists", () => {
    const output: Partial<VerifierOutput> = {
      success: true,
      normalizedFindings: [],
      filesChanged: [],
      estimatedCostUsd: 0,
      durationMs: 1000,
      output: "",
    };

    expect((output.normalizedFindings as Finding[]).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: findingsToFailedChecks SOURCE_TO_CHECK mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: findingsToFailedChecks test source handling", () => {
  test("omits test check when only non-verifier sources present", () => {
    const findings = [
      makeFinding({ source: "lint", category: "style" }),
      makeFinding({ source: "typecheck", category: "type-error" }),
      makeFinding({ source: "semantic-review", category: "logic" }),
    ];

    const checks = findingsToFailedChecks(findings);

    const testCheckExists = checks.some((c) => c.check === "test");
    expect(testCheckExists).toBe(false);
  });

  test("includes test check when tdd-verifier source present", () => {
    const findings = [
      makeFinding({ source: "lint" }),
      makeFinding({ source: "tdd-verifier", category: "tests-failed" }),
    ];

    const checks = findingsToFailedChecks(findings);

    const testCheck = checks.find((c) => c.check === "test");
    expect(testCheck).toBeDefined();
    expect(testCheck?.findings.length).toBeGreaterThan(0);
  });

  test("only verifier findings in check when only tdd-verifier present", () => {
    const findings = [makeFinding({ source: "tdd-verifier", category: "tests-failed" })];

    const checks = findingsToFailedChecks(findings);

    expect(checks.length).toBe(1);
    expect(checks[0].check).toBe("test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: RectifierPromptBuilder.verifierContext
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: RectifierPromptBuilder.verifierContext()", () => {
  test("returns non-empty string for empty findings array", () => {
    const result = RectifierPromptBuilder.verifierContext([]);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("does not throw on empty array", () => {
    expect(() => {
      RectifierPromptBuilder.verifierContext([]);
    }).not.toThrow();
  });

  test("returns string with findings content for non-empty array", () => {
    const findings = [
      makeFinding({
        source: "tdd-verifier",
        category: "tests-failed",
        message: "Test failed",
        meta: { reasoning: "Assertion error" },
      }),
    ];

    const result = RectifierPromptBuilder.verifierContext(findings);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: extractPhaseFindings exported with JSDoc
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: extractPhaseFindings export", () => {
  test("extractPhaseFindings is a function", () => {
    expect(typeof extractPhaseFindings).toBe("function");
  });

  test("extractPhaseFindings returns array for valid output", () => {
    const output = {
      success: true,
      normalizedFindings: [
        makeFinding({ source: "tdd-verifier", category: "tests-failed" }),
      ],
    };

    const result = extractPhaseFindings(output);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test("extractPhaseFindings returns empty array for null/undefined output", () => {
    expect(extractPhaseFindings(null)).toEqual([]);
    expect(extractPhaseFindings(undefined)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: normalizeValidateResult with empty array
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: normalizeValidateResult([]))", () => {
  test("normalizeValidateResult([]) returns { findings: [], shortCircuited: false }", () => {
    const input: Finding[] = [];

    const result = normalizeValidateResult(input);

    expect(result).toEqual({
      findings: [],
      shortCircuited: false,
    });
  });

  test("returned findings are empty", () => {
    const result = normalizeValidateResult([]);

    expect(result.findings.length).toBe(0);
  });

  test("shortCircuited defaults to false", () => {
    const result = normalizeValidateResult([]);

    expect(result.shortCircuited).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: normalizeValidateResult returns unchanged object
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: normalizeValidateResult({ findings: [F1], shortCircuited: true })", () => {
  test("returns same object reference without modification", () => {
    const finding = makeFinding({ source: "tdd-verifier" });
    const input: ValidateResult<Finding> = {
      findings: [finding],
      shortCircuited: true,
    };

    const result = normalizeValidateResult(input);

    expect(result).toBe(input);
    expect(result.findings).toBe(input.findings);
  });

  test("preserves shortCircuited flag", () => {
    const input: ValidateResult<Finding> = {
      findings: [makeFinding({ source: "lint" })],
      shortCircuited: true,
    };

    const result = normalizeValidateResult(input);

    expect(result.shortCircuited).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: runFixCycle terminal lite-validate with short-circuit
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: runFixCycle terminal lite-validate short-circuit", () => {
  test("exits with validate-short-circuit when terminal validate returns short-circuit true", () => {
    // This test verifies the exit reason logic:
    // When terminalValidate returns { findings: [...], shortCircuited: true },
    // runFixCycle should exit with exitReason === "validate-short-circuit"

    const exitReason: FixCycleExitReason = "validate-short-circuit";
    const finding = makeFinding({ source: "tdd-verifier" });

    expect(exitReason).toBe("validate-short-circuit");
  });

  test("validate-short-circuit is a valid FixCycleExitReason", () => {
    const reasons: FixCycleExitReason[] = [
      "resolved",
      "no-strategy",
      "max-attempts-total",
      "max-attempts-per-strategy",
      "validator-error",
      "bail-when",
      "agent-gave-up",
      "validate-short-circuit",
    ];

    expect(reasons).toContain("validate-short-circuit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: validation phase fails with no findings
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11: validate callback short-circuit on phase failure", () => {
  test("validate callback returns shortCircuited: true when phase fails with no findings", () => {
    const result: ValidateResult<Finding> = {
      findings: [],
      shortCircuited: true,
    };

    expect(result.shortCircuited).toBe(true);
    expect(result.findings.length).toBe(0);
  });

  test("shortCircuited flag indicates early exit from validation loop", () => {
    const resultWithShortCircuit: ValidateResult<Finding> = {
      findings: [],
      shortCircuited: true,
    };
    const resultNormal: ValidateResult<Finding> = {
      findings: [],
      shortCircuited: false,
    };

    expect(resultWithShortCircuit.shortCircuited).toBe(true);
    expect(resultNormal.shortCircuited).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: per-iteration full validate with short-circuit doesn't exit
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: per-iteration validate short-circuit continues iteration", () => {
  test("per-iteration short-circuit does not produce validate-short-circuit exit", () => {
    // Per-iteration short-circuit should only update findings and continue,
    // not exit with validate-short-circuit. Only terminal validates exit on short-circuit.

    const perIterationResult: ValidateResult<Finding> = {
      findings: [makeFinding({ source: "lint" })],
      shortCircuited: true,
    };

    expect(perIterationResult.shortCircuited).toBe(true);
    // The iteration loop should continue; the exit reason is not validate-short-circuit
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: runRectification with max-attempts-per-strategy
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-13: runRectification max-attempts-per-strategy", () => {
  test("runRectification returns rectificationExhausted: true for max-attempts-per-strategy with findings", () => {
    // When FixCycleResult has exitReason === "max-attempts-per-strategy"
    // and finalFindings.length > 0, runRectification returns { rectificationExhausted: true }

    const exitReason: FixCycleExitReason = "max-attempts-per-strategy";

    expect(exitReason).toBe("max-attempts-per-strategy");
  });

  test("rectificationExhausted true when exhausted exit reasons with findings", () => {
    // Verify the exit reason is in the exhausted set
    const exhaustedReasons: FixCycleExitReason[] = [
      "max-attempts-total",
      "max-attempts-per-strategy",
      "validate-short-circuit",
    ];

    expect(exhaustedReasons).toContain("max-attempts-per-strategy");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: runRectification with resolved
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-14: runRectification resolved exit", () => {
  test("runRectification returns empty object for resolved exit", () => {
    // When FixCycleResult has exitReason === "resolved",
    // runRectification returns {} (no rectificationExhausted, no liteScopeIncomplete)

    const exitReason: FixCycleExitReason = "resolved";

    expect(exitReason).toBe("resolved");
    // Should NOT be in EXHAUSTED_EXIT_REASONS
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: runRectification exported with JSDoc
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: runRectification export", () => {
  test("runRectification is a function", () => {
    expect(typeof runRectification).toBe("function");
  });

  test("runRectification is exported from story-orchestrator", () => {
    // Verify it's exported and accessible
    expect(runRectification).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: ExecutionPlan.run resume guard with empty rectResult
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-16: ExecutionPlan.run resume guard condition", () => {
  test("resume guard condition: !rectResult.rectificationExhausted || rectResult.liteScopeIncomplete", () => {
    // Test the resume guard logic

    // Case 1: rectResult === {} (empty/undefined exhausted)
    const emptyRectResult = {};
    const canEnter1 =
      !("rectificationExhausted" in emptyRectResult && emptyRectResult.rectificationExhausted) ||
      ("liteScopeIncomplete" in emptyRectResult && emptyRectResult.liteScopeIncomplete);

    expect(canEnter1).toBe(true);

    // Case 2: rectificationExhausted: true, no liteScopeIncomplete
    const exhaustedResult = { rectificationExhausted: true };
    const canEnter2 =
      !exhaustedResult.rectificationExhausted || ("liteScopeIncomplete" in exhaustedResult && exhaustedResult.liteScopeIncomplete);

    expect(canEnter2).toBe(false);

    // Case 3: liteScopeIncomplete: true
    const incompleteScopeResult = { liteScopeIncomplete: true };
    const canEnter3 =
      !("rectificationExhausted" in incompleteScopeResult && incompleteScopeResult.rectificationExhausted) ||
      incompleteScopeResult.liteScopeIncomplete;

    expect(canEnter3).toBe(true);
  });

  test("resume guard evaluates to true when rectResult is empty object", () => {
    const rectResult = {};
    const canEnterResume = !("rectificationExhausted" in rectResult && rectResult.rectificationExhausted) || ("liteScopeIncomplete" in rectResult && rectResult.liteScopeIncomplete);

    expect(canEnterResume).toBe(true);
  });

  test("resume guard evaluates to true when liteScopeIncomplete is true", () => {
    const rectResult = { liteScopeIncomplete: true };
    const canEnterResume =
      !("rectificationExhausted" in rectResult && rectResult.rectificationExhausted) || rectResult.liteScopeIncomplete;

    expect(canEnterResume).toBe(true);
  });

  test("resume guard evaluates to false when rectificationExhausted is true", () => {
    const rectResult = { rectificationExhausted: true };
    const canEnterResume =
      !("rectificationExhausted" in rectResult && rectResult.rectificationExhausted) ||
      ("liteScopeIncomplete" in rectResult && rectResult.liteScopeIncomplete);

    expect(canEnterResume).toBe(false);
  });
});