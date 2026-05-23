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
  _postRunDeps,
} from "../../../src/execution/post-run";
import {
  fullSuiteGateOp,
  greenfieldGateOp,
  implementerOp,
  testWriterOp,
  verifierOp,
} from "../../../src/operations";

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
