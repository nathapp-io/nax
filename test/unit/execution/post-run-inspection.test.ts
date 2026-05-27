/**
 * Post-Run Inspection Tests
 *
 * Tests for exported helpers and key paths in applyPostRunInspection /
 * decideStageAction from src/execution/post-run.ts.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  deriveTddFailureCategory,
  extractPauseReason,
  applyPostRunInspection,
  decideStageAction,
  _postRunDeps,
} from "../../../src/execution/post-run";
import type { InspectionOptions } from "../../../src/execution/post-run";
import { EXHAUSTED_EXIT_REASONS } from "../../../src/execution/story-orchestrator";
import type { StoryOrchestratorResult } from "../../../src/execution/story-orchestrator";
import type { Finding } from "../../../src/findings/types";
import {
  fullSuiteGateOp,
  greenfieldGateOp,
  implementerOp,
  testWriterOp,
  verifierOp,
  verifyScopedOp,
} from "../../../src/operations";
import { makeTestContext } from "../../helpers/pipeline-context";

// ─────────────────────────────────────────────────────────────────────────────
// extractPauseReason
// ─────────────────────────────────────────────────────────────────────────────

describe("extractPauseReason", () => {
  test("returns undefined when no phase has pauseReason", () => {
    expect(extractPauseReason({ implementer: { success: true } })).toBeUndefined();
  });

  test("returns first pauseReason found across phase outputs", () => {
    const result = extractPauseReason({
      verifier: { success: false, pauseReason: "greenfield-no-tests" },
    });
    expect(result).toBe("greenfield-no-tests");
  });

  test("returns undefined for empty phaseOutputs", () => {
    expect(extractPauseReason({})).toBeUndefined();
  });

  test("skips non-string pauseReason values", () => {
    expect(extractPauseReason({ p: { pauseReason: 42 } })).toBeUndefined();
  });

  test("skips empty-string pauseReason values", () => {
    expect(extractPauseReason({ p: { pauseReason: "" } })).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveTddFailureCategory
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveTddFailureCategory", () => {
  test("returns session-failure when test-writer failed", () => {
    const result = deriveTddFailureCategory({
      [testWriterOp.name]: { success: false },
    });
    expect(result).toBe("session-failure");
  });

  test("returns greenfield-no-tests when greenfield gate failed with that pauseReason", () => {
    const result = deriveTddFailureCategory({
      [greenfieldGateOp.name]: { success: false, pauseReason: "greenfield-no-tests" },
    });
    expect(result).toBe("greenfield-no-tests");
  });

  test("returns verifier failureCategory when verifier failed", () => {
    const result = deriveTddFailureCategory({
      [verifierOp.name]: { success: false, failureCategory: "isolation-violation" },
    });
    expect(result).toBe("isolation-violation");
  });

  test("returns tests-failing when verifier failed without explicit category", () => {
    const result = deriveTddFailureCategory({
      [verifierOp.name]: { success: false },
    });
    expect(result).toBe("tests-failing");
  });

  test("returns session-failure when implementer failed", () => {
    const result = deriveTddFailureCategory({
      [implementerOp.name]: { success: false },
    });
    expect(result).toBe("session-failure");
  });

  test("returns undefined when all phases succeeded", () => {
    const result = deriveTddFailureCategory({
      [testWriterOp.name]: { success: true },
      [implementerOp.name]: { success: true },
      [verifierOp.name]: { success: true },
    });
    expect(result).toBeUndefined();
  });

  test("test-writer failure takes precedence over verifier failure", () => {
    const result = deriveTddFailureCategory({
      [testWriterOp.name]: { success: false },
      [verifierOp.name]: { success: false, failureCategory: "tests-failing" },
    });
    expect(result).toBe("session-failure");
  });

  test("returns tests-failing when full-suite gate failed and verifier did not run", () => {
    // Verifier output absent — gate is the only failing phase. Routed as `escalate`
    // by routeTddFailure (same branch as a verifier-derived tests-failing).
    const result = deriveTddFailureCategory({
      [fullSuiteGateOp.name]: { success: false, passed: false, findings: [] },
    });
    expect(result).toBe("tests-failing");
  });

  test("verifier verdict takes precedence over a failing gate", () => {
    // When verifier ran AND succeeded, the gate failure is the verifier's judgment to
    // interpret (e.g. pre-existing/unrelated regressions). Verifier wins → no category.
    const result = deriveTddFailureCategory({
      [fullSuiteGateOp.name]: { success: false, passed: false, findings: [] },
      [verifierOp.name]: { success: true },
    });
    expect(result).toBeUndefined();
  });

  // ─── US-001: full-suite-gate-exhausted derivation ─────────────────────────

  test("returns full-suite-gate-exhausted when rectification exhausted with max-attempts-total and test-runner finding", () => {
    // AC-001-1
    const unfixedFindings: Finding[] = [
      { source: "test-runner", severity: "error", category: "test-failure", message: "failing test" },
    ];
    const result = deriveTddFailureCategory(
      { rectification: { exitReason: "max-attempts-total", success: false } },
      unfixedFindings,
    );
    expect(result).toBe("full-suite-gate-exhausted");
  });

  test("returns full-suite-gate-exhausted for every member of EXHAUSTED_EXIT_REASONS with a test-runner finding", () => {
    // AC-001-2: confirms all members of EXHAUSTED_EXIT_REASONS trigger the branch
    for (const exitReason of EXHAUSTED_EXIT_REASONS) {
      const unfixedFindings: Finding[] = [
        { source: "test-runner", severity: "error", category: "test-failure", message: "failing" },
      ];
      const result = deriveTddFailureCategory(
        { rectification: { exitReason, success: false } },
        unfixedFindings,
      );
      expect(result).toBe("full-suite-gate-exhausted");
    }
  });

  test("does NOT return full-suite-gate-exhausted when rectification exitReason is resolved", () => {
    // AC-001-3: non-exhausted exit reasons must not trigger the branch
    const unfixedFindings: Finding[] = [
      { source: "test-runner", severity: "error", category: "test-failure", message: "failing" },
    ];
    const result = deriveTddFailureCategory(
      { rectification: { exitReason: "resolved", success: true } },
      unfixedFindings,
    );
    expect(result).not.toBe("full-suite-gate-exhausted");
  });

  test("does NOT return full-suite-gate-exhausted when unfixedFindings has only lint source", () => {
    // AC-001-4: lint-only findings must not trigger the branch
    const unfixedFindings: Finding[] = [
      { source: "lint", severity: "warning", category: "style", message: "lint issue" },
    ];
    const result = deriveTddFailureCategory(
      { rectification: { exitReason: "max-attempts-total", success: false } },
      unfixedFindings,
    );
    expect(result).not.toBe("full-suite-gate-exhausted");
  });

  test("verifier-SSOT short-circuit wins over full-suite-gate-exhausted when verifier passed", () => {
    // AC-001-5: verifier pass still produces undefined even with exhausted rectification
    const unfixedFindings: Finding[] = [
      { source: "test-runner", severity: "error", category: "test-failure", message: "failing" },
    ];
    const result = deriveTddFailureCategory(
      {
        [verifierOp.name]: { success: true },
        rectification: { exitReason: "max-attempts-total", success: false },
      },
      unfixedFindings,
    );
    expect(result).toBeUndefined();
  });

  test("does NOT return full-suite-gate-exhausted when unfixedFindings omitted (backwards compat)", () => {
    // AC-001-6: single-arg call must not throw and must not return the new category
    let threw = false;
    let result: string | undefined;
    try {
      result = deriveTddFailureCategory({
        rectification: { exitReason: "max-attempts-total", success: false },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).not.toBe("full-suite-gate-exhausted");
  });

  test("returns undefined for empty phaseOutputs regardless of unfixedFindings", () => {
    // AC-001-7: no false-positive on completely empty outputs
    const result = deriveTddFailureCategory({}, [
      { source: "test-runner", severity: "error", category: "test-failure", message: "failing" },
    ]);
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 AC7/AC8: mechanicalFailedOnly rule in applyPostRunInspection
// ─────────────────────────────────────────────────────────────────────────────

function makePlanResult(overrides: Record<string, unknown> = {}): StoryOrchestratorResult {
  return {
    success: false,
    phaseCosts: {},
    totalCostUsd: 0,
    durationMs: 100,
    phaseOutputs: {
      [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
    },
    ...overrides,
  } as StoryOrchestratorResult;
}

function makeInspectionOpts(overrides: Partial<InspectionOptions> = {}): InspectionOptions {
  return {
    capturedResponse: "",
    capturedCostUsd: 0,
    tddMode: null,
    initialRef: null,
    ...overrides,
  };
}

const LINT_FINDING: Finding = { source: "lint", severity: "error", message: "unused var", category: "lint" };
const TYPECHECK_FINDING: Finding = { source: "typecheck", severity: "error", message: "type error", category: "type" };
const TEST_RUNNER_FINDING: Finding = { source: "test-runner", severity: "error", message: "test failed", category: "test" };
const SEMANTIC_REVIEW_FINDING: Finding = {
  source: "semantic-review",
  severity: "error",
  message: "semantic review failed",
  category: "ac-coverage",
  fixTarget: "source",
};

describe("AC7: mechanicalFailedOnly — all lint/typecheck unfixed → continue action", () => {
  let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
  let origDetect: typeof _postRunDeps.detectMergeConflict;
  let origFailClose: typeof _postRunDeps.failAndClose;

  beforeEach(() => {
    origAutoCommit = _postRunDeps.autoCommitIfDirty;
    origDetect = _postRunDeps.detectMergeConflict;
    origFailClose = _postRunDeps.failAndClose;
    _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
  });

  afterEach(() => {
    _postRunDeps.autoCommitIfDirty = origAutoCommit;
    _postRunDeps.detectMergeConflict = origDetect;
    _postRunDeps.failAndClose = origFailClose;
  });

  test("AC7: rectificationExhausted + all-lint unfixed → decideStageAction returns continue", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [LINT_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("continue");
  });

  test("AC7: rectificationExhausted + all-typecheck unfixed → decideStageAction returns continue", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TYPECHECK_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("continue");
  });

  test("AC7: rectificationExhausted + mixed lint+typecheck unfixed → decideStageAction returns continue", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [LINT_FINDING, TYPECHECK_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("continue");
  });
});

describe("AC8: mechanicalFailedOnly — non-mechanical source present → escalate action", () => {
  let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
  let origDetect: typeof _postRunDeps.detectMergeConflict;
  let origFailClose: typeof _postRunDeps.failAndClose;

  beforeEach(() => {
    origAutoCommit = _postRunDeps.autoCommitIfDirty;
    origDetect = _postRunDeps.detectMergeConflict;
    origFailClose = _postRunDeps.failAndClose;
    _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
  });

  afterEach(() => {
    _postRunDeps.autoCommitIfDirty = origAutoCommit;
    _postRunDeps.detectMergeConflict = origDetect;
    _postRunDeps.failAndClose = origFailClose;
  });

  test("AC8: rectificationExhausted + test-runner finding → decideStageAction returns escalate", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("AC8: rectificationExhausted + mixed lint+test-runner → escalate (not continue)", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [LINT_FINDING, TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("rectificationExhausted + semantic-review finding returns explicit exhaustion reason", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [SEMANTIC_REVIEW_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    if (result.action !== "escalate") {
      throw new Error(`Expected escalate action, got ${result.action}`);
    }
    expect(result.reason).toBe("Rectification exhausted with unfixed findings");
  });

  test("rectificationExhausted + semantic-review finding in TDD mode bypasses pause routing", async () => {
    const ctx = makeTestContext();
    const rollbackCalls: Array<{ workdir: string; ref: string }> = [];
    const origRollback = _postRunDeps.rollbackToRef;
    _postRunDeps.rollbackToRef = mock(async (workdir: string, ref: string) => {
      rollbackCalls.push({ workdir, ref });
    }) as typeof _postRunDeps.rollbackToRef;

    try {
      const planResult = makePlanResult({
        success: false,
        rectificationExhausted: true,
        unfixedFindings: [SEMANTIC_REVIEW_FINDING],
        phaseOutputs: {
          [testWriterOp.name]: { success: true },
          [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
          [fullSuiteGateOp.name]: { success: true, passed: true, findings: [] },
          [verifierOp.name]: { success: true },
          "semantic-review": { passed: false, findings: [SEMANTIC_REVIEW_FINDING] },
        },
      });
      const opts = makeInspectionOpts({
        tddMode: { isLite: false, rollbackEnabled: true },
        initialRef: "abc123",
      });
      const inspection = await applyPostRunInspection(ctx, planResult, opts);
      const result = await decideStageAction(ctx, planResult, inspection, opts);

      if (result.action !== "escalate") {
        throw new Error(`Expected escalate action, got ${result.action}`);
      }
      expect(result.reason).toBe("Rectification exhausted with unfixed findings");
      expect(rollbackCalls).toHaveLength(0);
    } finally {
      _postRunDeps.rollbackToRef = origRollback;
    }
  });

  test("rectificationExhausted does not bypass TDD isolation rollback", async () => {
    const ctx = makeTestContext();
    const rollbackCalls: Array<{ workdir: string; ref: string }> = [];
    const origRollback = _postRunDeps.rollbackToRef;
    _postRunDeps.rollbackToRef = mock(async (workdir: string, ref: string) => {
      rollbackCalls.push({ workdir, ref });
    }) as typeof _postRunDeps.rollbackToRef;

    try {
      const planResult = makePlanResult({
        success: false,
        rectificationExhausted: true,
        unfixedFindings: [TEST_RUNNER_FINDING],
        phaseOutputs: {
          [testWriterOp.name]: { success: true },
          [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
          [verifierOp.name]: { success: false, failureCategory: "isolation-violation" },
        },
      });
      const opts = makeInspectionOpts({
        tddMode: { isLite: false, rollbackEnabled: true },
        initialRef: "def456",
      });
      const inspection = await applyPostRunInspection(ctx, planResult, opts);
      const result = await decideStageAction(ctx, planResult, inspection, opts);

      expect(result.action).toBe("escalate");
      expect(rollbackCalls).toEqual([{ workdir: ctx.workdir, ref: "def456" }]);
    } finally {
      _postRunDeps.rollbackToRef = origRollback;
    }
  });

  test("rectificationExhausted preserves TDD failure category for downstream escalation", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
      phaseOutputs: {
        [testWriterOp.name]: { success: true },
        [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
        [verifierOp.name]: { success: false, failureCategory: "verifier-rejected" },
      },
    });
    const opts = makeInspectionOpts({
      tddMode: { isLite: false, rollbackEnabled: true },
      initialRef: "ghi789",
    });
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result.action).toBe("escalate");
    expect(ctx.tddFailureCategory).toBe("verifier-rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 AC9: ctx field derivations in applyPostRunInspection
// ─────────────────────────────────────────────────────────────────────────────

describe("AC9: applyPostRunInspection ctx field derivations", () => {
  test("AC9: sets ctx.verifyPassed=true when 'verifier' phase output has passed=true", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        [verifierOp.name]: { success: true, passed: true, findings: [] },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect((ctx as any).verifyPassed).toBe(true);
  });

  test("AC9: sets ctx.verifyPassed=false when 'verifier' phase output has passed=false", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        [verifierOp.name]: { success: false, passed: false, findings: [TEST_RUNNER_FINDING] },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect((ctx as any).verifyPassed).toBe(false);
  });

  test("AC9: derives ctx.verifyPassed from 'verify-scoped' when no 'verifier' phase present", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        [verifyScopedOp.name]: { success: true, passed: true, findings: [] },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect((ctx as any).verifyPassed).toBe(true);
  });

  test("AC9: sets ctx.semanticReviewResult from 'semantic-review' phase output when present", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        "semantic-review": { passed: true, findings: [] },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect((ctx as any).semanticReviewResult).toBeDefined();
    expect((ctx as any).semanticReviewResult.passed).toBe(true);
  });

  test("AC9: ctx.semanticReviewResult is undefined when 'semantic-review' not in phaseOutputs", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect((ctx as any).semanticReviewResult).toBeUndefined();
  });

  test("AC9: sets ctx.rectificationIterationCount=0 when no rectification phase ran", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect((ctx as any).rectificationIterationCount).toBe(0);
  });

  test("AC9: sets ctx.rectificationIterationCount from rectification phase iteration count", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        rectification: { iterationCount: 3 },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect((ctx as any).rectificationIterationCount).toBe(3);
  });
});

describe("TDD rollback gating", () => {
  let origRollback: typeof _postRunDeps.rollbackToRef;
  let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
  let origDetect: typeof _postRunDeps.detectMergeConflict;
  let origFailClose: typeof _postRunDeps.failAndClose;

  beforeEach(() => {
    origRollback = _postRunDeps.rollbackToRef;
    origAutoCommit = _postRunDeps.autoCommitIfDirty;
    origDetect = _postRunDeps.detectMergeConflict;
    origFailClose = _postRunDeps.failAndClose;
    _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
  });

  afterEach(() => {
    _postRunDeps.rollbackToRef = origRollback;
    _postRunDeps.autoCommitIfDirty = origAutoCommit;
    _postRunDeps.detectMergeConflict = origDetect;
    _postRunDeps.failAndClose = origFailClose;
  });

  test("semantic review failure in TDD mode pauses without git rollback", async () => {
    const ctx = makeTestContext();
    const rollbackCalls: Array<{ workdir: string; ref: string }> = [];
    _postRunDeps.rollbackToRef = mock(async (workdir: string, ref: string) => {
      rollbackCalls.push({ workdir, ref });
    }) as typeof _postRunDeps.rollbackToRef;

    const planResult = makePlanResult({
      success: false,
      phaseOutputs: {
        [testWriterOp.name]: { success: true },
        [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
        [fullSuiteGateOp.name]: { success: true, passed: true, findings: [] },
        [verifierOp.name]: { success: true },
        "semantic-review": {
          passed: false,
          findings: [{ source: "semantic-review", severity: "error", message: "semantic fail", category: "semantic" }],
        },
      },
    });
    const opts = makeInspectionOpts({
      tddMode: { isLite: false, rollbackEnabled: true },
      initialRef: "abc123",
    });

    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(inspection.failureCategory).toBeUndefined();
    expect(result.action).toBe("pause");
    expect(rollbackCalls).toHaveLength(0);
  });

  test("isolation violation in TDD mode still rolls back before escalating", async () => {
    const ctx = makeTestContext();
    const rollbackCalls: Array<{ workdir: string; ref: string }> = [];
    _postRunDeps.rollbackToRef = mock(async (workdir: string, ref: string) => {
      rollbackCalls.push({ workdir, ref });
    }) as typeof _postRunDeps.rollbackToRef;

    const planResult = makePlanResult({
      success: false,
      phaseOutputs: {
        [testWriterOp.name]: { success: true },
        [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
        [verifierOp.name]: { success: false, failureCategory: "isolation-violation" },
      },
    });
    const opts = makeInspectionOpts({
      tddMode: { isLite: false, rollbackEnabled: true },
      initialRef: "def456",
    });

    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(inspection.failureCategory).toBe("isolation-violation");
    expect(result.action).toBe("escalate");
    expect(rollbackCalls).toEqual([{ workdir: ctx.workdir, ref: "def456" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _postRunDeps rollback injection
// ─────────────────────────────────────────────────────────────────────────────

describe("_postRunDeps.rollbackToRef injection", () => {
  let origRollback: typeof _postRunDeps.rollbackToRef;

  beforeEach(() => {
    origRollback = _postRunDeps.rollbackToRef;
  });

  afterEach(() => {
    _postRunDeps.rollbackToRef = origRollback;
  });

  test("rollbackToRef dep is replaceable", () => {
    let called = false;
    _postRunDeps.rollbackToRef = mock(async () => {
      called = true;
    });
    _postRunDeps.rollbackToRef("/tmp", "HEAD");
    expect(called).toBe(true);
  });
});
