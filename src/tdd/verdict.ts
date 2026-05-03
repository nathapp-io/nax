/**
 * Verifier Verdict — types and categorization
 *
 * The verifier (session 3) writes a structured verdict file to
 * `.nax-verifier-verdict.json` in the workdir. This module reads,
 * validates, interprets, and categorizes that verdict.
 *
 * Re-exports parser and coercer modules for backward compatibility.
 */

import type { FailureCategory } from "./types";

// Re-export for backward compatibility
export { VERDICT_FILE, isValidVerdict, readVerdict, cleanupVerdict, coerceVerdict } from "./verdict-reader";

/** Structured verdict written by the verifier (session 3) */
export interface VerifierVerdict {
  /** Schema version */
  version: 1;

  /** Overall approval */
  approved: boolean;

  /** Test results */
  tests: {
    /** Did all tests pass? */
    allPassing: boolean;
    /** Number of passing tests */
    passCount: number;
    /** Number of failing tests */
    failCount: number;
  };

  /** Implementer test modification review */
  testModifications: {
    /** Were test files modified by implementer? */
    detected: boolean;
    /** List of modified test files */
    files: string[];
    /** Are the modifications legitimate? */
    legitimate: boolean;
    /** Reasoning for legitimacy judgment */
    reasoning: string;
  };

  /** Acceptance criteria check */
  acceptanceCriteria: {
    /** All criteria met? */
    allMet: boolean;
    /** Per-criterion status */
    criteria: Array<{
      criterion: string;
      met: boolean;
      note?: string;
    }>;
  };

  /** Code quality assessment */
  quality: {
    /** Overall quality: good | acceptable | poor */
    rating: "good" | "acceptable" | "poor";
    /** Issues found */
    issues: string[];
  };

  /** Fixes applied by the verifier */
  fixes: string[];

  /** Overall reasoning */
  reasoning: string;
}

/** Result of categorizing a verifier verdict */
export interface VerdictCategorization {
  success: boolean;
  failureCategory?: FailureCategory;
  reviewReason?: string;
}

/**
 * Categorize a verifier verdict into a success/failure outcome.
 *
 * @param verdict - The parsed verdict (or null if not available)
 * @param testsPass - Fallback: whether tests pass independently (used when verdict is null)
 * @returns Categorized outcome with optional failureCategory and reviewReason
 *
 * Logic:
 * - verdict.approved = true → success
 * - Not approved, illegitimate test mods → verifier-rejected
 * - Not approved, tests failing → tests-failing
 * - Not approved for semantic AC/quality concerns only → success (advisory; semantic review owns these)
 * - Not approved, other → success (advisory; verifier only blocks TDD integrity failures)
 * - null verdict, testsPass=true → success
 * - null verdict, testsPass=false → tests-failing
 */
export function categorizeVerdict(verdict: VerifierVerdict | null, testsPass: boolean): VerdictCategorization {
  if (!verdict) {
    if (testsPass) {
      return { success: true };
    }
    return {
      success: false,
      failureCategory: "tests-failing",
      reviewReason: "Tests failing after all sessions (no verdict file)",
    };
  }

  if (verdict.approved) {
    return { success: true };
  }

  if (verdict.testModifications.detected && !verdict.testModifications.legitimate) {
    const files = verdict.testModifications.files.join(", ") || "unknown files";
    return {
      success: false,
      failureCategory: "verifier-rejected",
      reviewReason: `Verifier rejected: illegitimate test modifications in ${files}. ${verdict.testModifications.reasoning}`,
    };
  }

  if (!verdict.tests.allPassing) {
    return {
      success: false,
      failureCategory: "tests-failing",
      reviewReason: `Tests failing: ${verdict.tests.failCount} failure(s). ${verdict.reasoning}`,
    };
  }

  return { success: true };
}
