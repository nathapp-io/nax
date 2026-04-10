/**
 * Unit tests for semantic-aware diagnosis fast path
 *
 * Covers:
 * - isTestLevelFailure heuristics (>80%, AC-ERROR sentinel, semantic verdicts)
 * - resolveAcceptanceDiagnosis fast paths via integration with semantic verdicts
 *
 * NOTE: These tests previously targeted runFixRouting, which was replaced by
 * resolveAcceptanceDiagnosis + applyFix in the acceptance retry restructure
 * (US-002/003/004). Tests for the new functions live in acceptance-fix.test.ts.
 * This file now focuses on the heuristic helpers used by the fast paths.
 */

import { describe, expect, test } from "bun:test";
import { isTestLevelFailure } from "../../../../src/execution/lifecycle/acceptance-helpers";
import type { SemanticVerdict } from "../../../../src/acceptance/types";

function makePassingVerdict(storyId: string): SemanticVerdict {
  return { storyId, passed: true, timestamp: new Date().toISOString(), acCount: 2, findings: [] };
}

function makeFailingVerdict(storyId: string): SemanticVerdict {
  return { storyId, passed: false, timestamp: new Date().toISOString(), acCount: 2, findings: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// isTestLevelFailure — semantic verdict override
// ─────────────────────────────────────────────────────────────────────────────

describe("isTestLevelFailure — all semanticVerdicts passed", () => {
  test("returns true when all verdicts passed, regardless of low failedACs ratio", () => {
    const verdicts = [makePassingVerdict("US-001"), makePassingVerdict("US-002")];
    // 1/10 = 10% < 80% would normally be false, but semantic override applies
    expect(isTestLevelFailure(["AC-1"], 10, verdicts)).toBe(true);
  });

  test("returns true when all verdicts passed even with zero failedACs", () => {
    const verdicts = [makePassingVerdict("US-001")];
    expect(isTestLevelFailure([], 10, verdicts)).toBe(true);
  });

  test("returns true when all verdicts passed with numeric zero failedCount", () => {
    const verdicts = [makePassingVerdict("US-001")];
    expect(isTestLevelFailure(0, 10, verdicts)).toBe(true);
  });

  test("does NOT short-circuit via semantic when some verdicts failed", () => {
    const verdicts = [makePassingVerdict("US-001"), makeFailingVerdict("US-002")];
    expect(isTestLevelFailure(["AC-1", "AC-2"], 10, verdicts)).toBe(false);
  });

  test("does NOT short-circuit via semantic when all verdicts failed", () => {
    const verdicts = [makeFailingVerdict("US-001"), makeFailingVerdict("US-002")];
    expect(isTestLevelFailure(["AC-1"], 10, verdicts)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isTestLevelFailure — >80% heuristic fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("isTestLevelFailure — heuristic fallback when semanticVerdicts undefined or empty", () => {
  test("returns true when >80% ACs fail and semanticVerdicts is undefined", () => {
    const failedACs = Array.from({ length: 9 }, (_, i) => `AC-${i + 1}`);
    expect(isTestLevelFailure(failedACs, 10, undefined)).toBe(true);
  });

  test("returns false when <=80% ACs fail and semanticVerdicts is undefined", () => {
    expect(isTestLevelFailure(["AC-1", "AC-2", "AC-3"], 10, undefined)).toBe(false);
  });

  test("returns true when >80% ACs fail and semanticVerdicts is empty array", () => {
    const failedACs = Array.from({ length: 9 }, (_, i) => `AC-${i + 1}`);
    expect(isTestLevelFailure(failedACs, 10, [])).toBe(true);
  });

  test("returns false when <=80% ACs fail and semanticVerdicts is empty array", () => {
    expect(isTestLevelFailure(["AC-1", "AC-2", "AC-3"], 10, [])).toBe(false);
  });

  test("returns false when totalACs is 0 regardless of failedACs (no verdicts)", () => {
    expect(isTestLevelFailure(["AC-1"], 0, undefined)).toBe(false);
  });

  test("returns true when AC-ERROR sentinel present", () => {
    expect(isTestLevelFailure(["AC-ERROR"], 10, undefined)).toBe(true);
  });

  test("returns true when AC-ERROR sentinel mixed with other failures", () => {
    expect(isTestLevelFailure(["AC-1", "AC-ERROR", "AC-2"], 10, undefined)).toBe(true);
  });
});
