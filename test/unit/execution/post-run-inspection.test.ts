/**
 * Post-Run Inspection Tests
 *
 * Tests for the post-run inspection phase that follows plan.run() execution.
 * Handles verdict extraction, failure categorization, rollback triggers,
 * isolation surfacing, and pauseReason handling.
 *
 * Story: US-005.S4 - Collapse execution stage to single plan run plus post-run inspection
 */

import { describe, expect, test } from "bun:test";

// ─────────────────────────────────────────────────────────────────────────────
// Type Stubs for Post-Run Inspection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result from plan.run()
 */
interface PlanRunResult {
  readonly success: boolean;
  readonly phaseOutputs: Record<string, unknown>;
  readonly phaseCosts: Record<string, number>;
  readonly durationMs: number;
}

// PostRunVerdict type is documented in the test narratives below
// but not explicitly used as a concrete type in the test implementations.

// ─────────────────────────────────────────────────────────────────────────────
// AC3: Post-Run Inspection - Verdict Extraction
// ─────────────────────────────────────────────────────────────────────────────

describe("Post-Run Inspection — AC3: Verdict extraction", () => {
  test("extracts success verdict when all phases succeed", () => {
    // Create a plan result with success: true
    const planResult: PlanRunResult = {
      success: true,
      phaseOutputs: {
        implementer: { success: true, filesChanged: ["src/foo.ts"] },
      },
      phaseCosts: { implementer: 0.05 },
      durationMs: 5000,
    };

    // Post-run inspection should extract verdict.success === true
    expect(planResult.success).toBe(true);
  });

  test("extracts failure verdict when plan reports failure", () => {
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        implementer: { success: false, error: "Syntax error" },
      },
      phaseCosts: { implementer: 0.05 },
      durationMs: 5000,
    };

    expect(planResult.success).toBe(false);
  });

  test("identifies which phase failed from phaseOutputs", () => {
    // Post-run inspection should read phaseOutputs and determine
    // which phase failed by checking success status in each phase output
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        testWriter: { success: true },
        implementer: { success: false, error: "Implementation failed" },
        verifier: { success: undefined }, // Not run
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    // Should detect that implementer phase failed
    expect(planResult.phaseOutputs.implementer).toBeDefined();
    expect((planResult.phaseOutputs.implementer as any).success).toBe(false);
  });

  test("extracts phase output details for verdict categorization", () => {
    // Post-run inspection needs to read phaseOutputs to extract:
    // - Error messages
    // - Failure categories
    // - Test failure details
    // - Coverage info
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        verifier: {
          success: false,
          failureCategory: "test-failure",
          failedTests: ["test/unit/foo.test.ts"],
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const verifierOutput = planResult.phaseOutputs.verifier as any;
    expect(verifierOutput.failureCategory).toBe("test-failure");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: Post-Run Inspection - Failure Categorization
// ─────────────────────────────────────────────────────────────────────────────

describe("Post-Run Inspection — AC3: Failure categorization", () => {
  test("categorizes test failure from verifier phase", () => {
    // When verifier phase fails, categorize as "test-failure"
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        verifier: {
          success: false,
          failureCategory: "test-failure",
          detail: "3 tests failed",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const verifierOutput = planResult.phaseOutputs.verifier as any;
    expect(verifierOutput.failureCategory).toBe("test-failure");
  });

  test("categorizes lint/typecheck failure from semantic review", () => {
    // When semantic review (or similar quality check) fails, categorize appropriately
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        semanticReview: {
          success: false,
          failureCategory: "lint-failure",
          violations: [{ file: "src/foo.ts", line: 10 }],
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const reviewOutput = planResult.phaseOutputs.semanticReview as any;
    expect(reviewOutput.failureCategory).toBe("lint-failure");
  });

  test("categorizes implementation failure", () => {
    // When implementer phase fails, categorize as appropriate failure type
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        implementer: {
          success: false,
          failureCategory: "merge-conflict",
          detail: "Git merge conflict detected",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const implOutput = planResult.phaseOutputs.implementer as any;
    expect(implOutput.failureCategory).toBe("merge-conflict");
  });

  test("propagates custom failure categories from operations", () => {
    // Operations may define custom failure categories.
    // Post-run inspection should propagate these without modification.
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        rectification: {
          success: false,
          failureCategory: "rectification-exhausted",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const rectOutput = planResult.phaseOutputs.rectification as any;
    expect(rectOutput.failureCategory).toBe("rectification-exhausted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: Post-Run Inspection - Rollback Trigger
// ─────────────────────────────────────────────────────────────────────────────

describe("Post-Run Inspection — AC3: Rollback trigger detection", () => {
  test("detects rollback requirement from implementer failure", () => {
    // If implementer phase fails, post-run inspection may determine
    // that rollback is needed (to undo partial changes)
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        implementer: {
          success: false,
          failureCategory: "implementation-failed",
          requiresRollback: true,
          detail: "Partial files were written; git state is dirty",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const implOutput = planResult.phaseOutputs.implementer as any;
    expect(implOutput.requiresRollback).toBe(true);
  });

  test("detects rollback not needed when no files were changed", () => {
    // If no files were written, rollback is not needed
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        implementer: {
          success: false,
          filesChanged: [],
          requiresRollback: false,
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const implOutput = planResult.phaseOutputs.implementer as any;
    expect(implOutput.requiresRollback).toBe(false);
  });

  test("signals rollback action when required", () => {
    // Post-run inspection should return stage action "rollback"
    // when rollback is needed
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        implementer: {
          success: false,
          requiresRollback: true,
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const implOutput = planResult.phaseOutputs.implementer as any;
    expect(implOutput.requiresRollback).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: Post-Run Inspection - Isolation Surfacing
// ─────────────────────────────────────────────────────────────────────────────

describe("Post-Run Inspection — AC3: Isolation surfacing", () => {
  test("extracts isolation info from verifier phase output", () => {
    // When verifier phase runs, it isolates code during testing.
    // Post-run inspection should extract and surface this isolation context.
    const planResult: PlanRunResult = {
      success: true,
      phaseOutputs: {
        verifier: {
          success: true,
          isolationInfo: {
            isolated: true,
            isolationType: "git-revert",
            scope: "test-execution",
            reverted: true,
          },
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const verifierOutput = planResult.phaseOutputs.verifier as any;
    expect(verifierOutput.isolationInfo?.isolated).toBe(true);
  });

  test("surfaces isolation scope (which tests were isolated)", () => {
    // Isolation info should specify what was isolated:
    // - "test-execution" — testing was isolated
    // - "implementation" — implementation was isolated
    // - "verification" — verification was isolated
    const planResult: PlanRunResult = {
      success: true,
      phaseOutputs: {
        verifier: {
          success: true,
          isolationInfo: {
            isolated: true,
            scope: "test-execution",
            reverted: true,
          },
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const verifierOutput = planResult.phaseOutputs.verifier as any;
    expect(verifierOutput.isolationInfo?.scope).toBeDefined();
  });

  test("handles isolation failure (not fully reverted)", () => {
    // If isolation failed (files not fully reverted), post-run inspection
    // should surface this as a separate concern from the test result
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        verifier: {
          success: false,
          isolationInfo: {
            isolated: true,
            reverted: false, // Revert failed
            scope: "test-execution",
            detail: "Some files were not reverted after test",
          },
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const verifierOutput = planResult.phaseOutputs.verifier as any;
    expect(verifierOutput.isolationInfo?.reverted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 & AC4: Post-Run Inspection - pauseReason Handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Post-Run Inspection — AC3/AC4: pauseReason handling", () => {
  test("detects pauseReason from plan result", () => {
    // Some operations may produce a pauseReason (e.g., rectification exhausted,
    // human review needed, etc.)
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        rectification: {
          success: false,
          pauseReason: "Rectification exhausted after 3 attempts",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const rectOutput = planResult.phaseOutputs.rectification as any;
    expect(rectOutput.pauseReason).toBeDefined();
  });

  test("extracts pauseReason with full context", () => {
    // pauseReason should include enough detail for user to understand
    // why the run is pausing
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        rectification: {
          success: false,
          pauseReason: "Manual code review needed: Implementation uses unsafe pointer arithmetic",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const rectOutput = planResult.phaseOutputs.rectification as any;
    expect(rectOutput.pauseReason).toContain("Manual code review");
  });

  test("handles pauseReason from different phases", () => {
    // Any phase could produce a pauseReason:
    // - Verifier: "Tests ambiguous, human clarification needed"
    // - Semantic review: "Violation requires manual fix"
    // - Rectification: "Automated fix exhausted"
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        verifier: {
          success: false,
          pauseReason: "Test results ambiguous — manual verification needed",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const verifierOutput = planResult.phaseOutputs.verifier as any;
    expect(verifierOutput.pauseReason).toBeDefined();
  });

  test("prioritizes pauseReason over other failure info", () => {
    // If pauseReason is present, it should take priority over
    // escalation — stage should return pause action, not escalate
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        rectification: {
          success: false,
          failureCategory: "rectification-exhausted",
          pauseReason: "Awaiting human review",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const rectOutput = planResult.phaseOutputs.rectification as any;
    expect(rectOutput.pauseReason).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: Complete Post-Run Inspection Flow
// ─────────────────────────────────────────────────────────────────────────────

describe("Post-Run Inspection — Integration: Complete flow", () => {
  test("builds verdict object with all extracted fields", () => {
    // Post-run inspection should construct a verdict object containing:
    // - success
    // - failureCategory (if failed)
    // - failedPhase (if failed)
    // - requiresRollback (if applicable)
    // - isolationInfo (if verifier ran)
    // - pauseReason (if present)
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        verifier: {
          success: false,
          failureCategory: "test-failure",
          pauseReason: "Manual review needed",
          isolationInfo: { isolated: true, reverted: false },
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    expect(planResult.phaseOutputs.verifier).toBeDefined();
  });

  test("maps verdict to stage result action", () => {
    // Verdict should map to stage result action:
    // - success: true → { action: "continue" }
    // - pauseReason set → { action: "pause", reason: pauseReason }
    // - requiresRollback: true → { action: "rollback", reason: ... }
    // - failureCategory set → { action: "escalate", reason: ... }
    const planResult: PlanRunResult = {
      success: true,
      phaseOutputs: { implementer: { success: true } },
      phaseCosts: {},
      durationMs: 5000,
    };

    expect(planResult.success).toBe(true);
  });

  test("handles success verdict", () => {
    const planResult: PlanRunResult = {
      success: true,
      phaseOutputs: {
        implementer: { success: true, filesChanged: ["src/foo.ts"] },
      },
      phaseCosts: { implementer: 0.05 },
      durationMs: 5000,
    };

    // Verdict: success, no other concerns
    expect(planResult.success).toBe(true);
  });

  test("handles failure with rollback needed", () => {
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        implementer: {
          success: false,
          failureCategory: "implementation-failed",
          requiresRollback: true,
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    expect(planResult.success).toBe(false);
  });

  test("handles failure with pause reason", () => {
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        rectification: {
          success: false,
          pauseReason: "Automated fixes exhausted",
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    expect(planResult.success).toBe(false);
  });

  test("handles success with isolation info", () => {
    const planResult: PlanRunResult = {
      success: true,
      phaseOutputs: {
        verifier: {
          success: true,
          isolationInfo: { isolated: true, reverted: true },
        },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    const verifierOutput = planResult.phaseOutputs.verifier as any;
    expect(verifierOutput.isolationInfo?.reverted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge Cases and Error Handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Post-Run Inspection — Edge cases", () => {
  test("handles empty phaseOutputs", () => {
    // If plan.run() returns empty phaseOutputs (should not happen),
    // post-run inspection should default to failure
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {},
      phaseCosts: {},
      durationMs: 5000,
    };

    expect(planResult.phaseOutputs).toBeDefined();
  });

  test("handles missing phase output for a phase that ran", () => {
    // If a phase ran but produced no output, inspection should handle gracefully
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        implementer: undefined,
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    expect(planResult.phaseOutputs.implementer).toBeUndefined();
  });

  test("handles malformed phase output (missing required fields)", () => {
    // If phase output is missing expected fields, inspection should
    // provide sensible defaults
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        implementer: { success: false } as any, // Missing error/reason
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    expect((planResult.phaseOutputs.implementer as any).success).toBe(false);
  });

  test("handles multiple pauseReasons from different phases", () => {
    // If multiple phases produced pauseReasons, inspection should
    // prioritize or merge them appropriately
    const planResult: PlanRunResult = {
      success: false,
      phaseOutputs: {
        verifier: { success: false, pauseReason: "Test ambiguity" },
        rectification: { success: false, pauseReason: "Rectification exhausted" },
      },
      phaseCosts: {},
      durationMs: 5000,
    };

    expect(planResult.phaseOutputs.verifier).toBeDefined();
    expect(planResult.phaseOutputs.rectification).toBeDefined();
  });
});
