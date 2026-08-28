/**
 * Post-Run Inspection Tests
 *
 * Tests for exported helpers and key paths in applyPostRunInspection /
 * decideStageAction from src/execution/post-run.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeTestContext } from "@test/helpers";
import {
  _postRunDeps,
  applyPostRunInspection,
  decideStageAction,
  deriveTddFailureCategory,
  extractPauseReason,
} from "@/execution/post-run";
import { EXHAUSTED_EXIT_REASONS } from "@/execution/story-orchestrator";
import type { Finding } from "@/findings/types";
import {
  fullSuiteGateOp,
  greenfieldGateOp,
  implementerOp,
  testPresenceGateOp,
  testWriterOp,
  verifierOp,
} from "@/operations";
import { makeInspectionOpts, makePlanResult } from "./_post-run-fixtures";

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

  test("returns no-tests-authored when test-presence gate failed with that pauseReason", () => {
    const result = deriveTddFailureCategory({
      [testPresenceGateOp.name]: { success: false, pauseReason: "no-tests-authored" },
    });
    expect(result).toBe("no-tests-authored");
  });

  test("test-presence-gate failure takes precedence over verifier failure (checked before verifier in deriveTddFailureCategory)", () => {
    // deriveTddFailureCategory checks: testWriter → greenfield → testPresence → verifier.
    // So test-presence-gate wins when both it and the verifier fail.
    const result = deriveTddFailureCategory({
      [testPresenceGateOp.name]: { success: false, pauseReason: "no-tests-authored" },
      [verifierOp.name]: { success: false },
    });
    expect(result).toBe("no-tests-authored");
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

  // ─── US-002: review-incomplete (configured review never ran) ──────────────

  test("returns review-incomplete in the carve-out case (verifier passed, gate red, review absent)", () => {
    // Verifier passed → gate-derived categories skipped → the missing review is the
    // real reason. Routes to escalation so a stronger tier can green the gate and run it.
    const result = deriveTddFailureCategory(
      {
        [fullSuiteGateOp.name]: { success: false, passed: false, findings: [] },
        [verifierOp.name]: { success: true },
      },
      undefined,
      false,
      ["adversarial-review"],
    );
    expect(result).toBe("review-incomplete");
  });

  test("a genuine red gate (verifier did NOT pass) keeps tests-failing even with a missing review (no masking)", () => {
    // review-incomplete is checked LAST — a real gate failure must not be masked into
    // review-incomplete (which would flip the max-attempts outcome from fail to pause).
    const result = deriveTddFailureCategory(
      {
        [fullSuiteGateOp.name]: { success: false, passed: false, findings: [] },
      },
      undefined,
      false,
      ["adversarial-review"],
    );
    expect(result).toBe("tests-failing");
  });

  test("a session failure outranks a missing review", () => {
    const result = deriveTddFailureCategory({ [implementerOp.name]: { success: false } }, undefined, false, [
      "semantic-review",
      "adversarial-review",
    ]);
    expect(result).toBe("session-failure");
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
      const result = deriveTddFailureCategory({ rectification: { exitReason, success: false } }, unfixedFindings);
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

  // ── issue #1132: validator-error → runtime-crash ──────────────────────────

  test("returns runtime-crash when rectification exitReason is validator-error", () => {
    // AC-2: mid-rectification validator crash → runtime-crash category
    const result = deriveTddFailureCategory({
      rectification: { exitReason: "validator-error", success: false },
    });
    expect(result).toBe("runtime-crash");
  });

  test("does NOT return runtime-crash for validator-error when verifier passed", () => {
    // verifierPassed guard must suppress the validator-error branch
    const result = deriveTddFailureCategory({
      [verifierOp.name]: { success: true },
      rectification: { exitReason: "validator-error", success: false },
    });
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005 AC9: ctx field derivations in applyPostRunInspection
// ─────────────────────────────────────────────────────────────────────────────

describe("AC9: applyPostRunInspection ctx field derivations", () => {
  // #1084 AC9 also pinned ctx.verifyPassed and ctx.semanticReviewResult here. Both were
  // written through a cast onto undeclared keys and never read by anything, so the tests
  // asserted a write that went nowhere; the writes are removed and these with them
  // (nax#1707 follow-up). The rectification derivation below is the one AC9 field with a
  // real consumer.
  // #1707 follow-up: the count was written to an undeclared `rectificationIterationCount`
  // through a cast, while collectStoryMetrics reads the declared `ctx.rectifyAttempt`.
  // Nothing read the former and nothing wrote the latter, so firstPassSuccess was never
  // disqualified by rectification (BUG-067 / issue #679).
  test("AC9: sets ctx.rectifyAttempt=0 when no rectification phase ran", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect(ctx.rectifyAttempt).toBe(0);
  });

  test("AC9: sets ctx.rectifyAttempt from rectification phase iteration count", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        rectification: { iterationCount: 3 },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect(ctx.rectifyAttempt).toBe(3);
  });

  // ENH-20: a review that fail-opened (LLM dispatch failed, gate degraded to
  // a pass) must be distinguishable from a review that actually ran.
  test("ENH-20: sets ctx.reviewsFailedOpen when a review phase returns failOpen:true", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        "semantic-review": { success: true, failOpen: true, findings: [] },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect(ctx.reviewsFailedOpen).toBe(1);
  });

  test("ENH-20: counts both semantic and adversarial fail-opens", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        "semantic-review": { success: true, failOpen: true, findings: [] },
        "adversarial-review": { success: true, failOpen: true, findings: [] },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect(ctx.reviewsFailedOpen).toBe(2);
  });

  test("ENH-20: ctx.reviewsFailedOpen stays unset when reviews genuinely passed", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      phaseOutputs: {
        [implementerOp.name]: { success: true },
        "semantic-review": { success: true, findings: [] },
        "adversarial-review": { success: true, findings: [] },
      },
    });
    await applyPostRunInspection(ctx, planResult, makeInspectionOpts());
    expect(ctx.reviewsFailedOpen).toBeUndefined();
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

  test("rollbackToRef dep is replaceable", async () => {
    let called = false;
    _postRunDeps.rollbackToRef = mock(async () => {
      called = true;
    });
    await _postRunDeps.rollbackToRef("/tmp", "HEAD", null);
    expect(called).toBe(true);
  });
});
