/**
 * Three-Session TDD Types
 *
 * Session 1: Test Writer — writes failing tests only
 * Session 2: Implementer — makes tests pass
 * Session 3: Verifier — reviews changes for legitimacy
 */

/** TDD session role */
export type TddSessionRole = "test-writer" | "implementer" | "verifier";

/** Failure categories for TDD orchestrator results */
export type FailureCategory =
  /** Test-writer violated file isolation or created no test files */
  | "isolation-violation"
  /** A session crashed, timed out, or the agent failed to produce usable output */
  | "session-failure"
  /** Tests were written and implemented but still fail after all sessions */
  | "tests-failing"
  /** Verifier explicitly rejected the implementation */
  | "verifier-rejected";

/** Isolation verification result */
export interface IsolationCheck {
  /** Whether isolation was maintained (or warning accepted) */
  passed: boolean;
  /** Files that violated strict isolation */
  violations: string[];
  /** Warnings for minor violations (e.g. modifying existing tests) */
  warnings?: string[];
  /** Files that matched allowed paths (soft violations, logged as warnings) */
  softViolations?: string[];
  /** Description of what was checked */
  description: string;
}

/** Verifier decision */
export interface VerifierDecision {
  /** Whether the changes are approved */
  approved: boolean;
  /** Files that were modified in test/ (if any) */
  testModifications: string[];
  /** Whether modifications were deemed legitimate */
  legitimate: boolean;
  /** Reasoning */
  reasoning: string;
}

/** Result of a single TDD session */
export interface TddSessionResult {
  /** Session role */
  role: TddSessionRole;
  /** Whether the session succeeded */
  success: boolean;
  /** Isolation check result */
  isolation?: IsolationCheck;
  /** Verifier decision (session 3 only) */
  verifierDecision?: VerifierDecision;
  /** Git diff summary */
  filesChanged: string[];
  /** Duration in ms */
  durationMs: number;
  /** Cost estimate */
  estimatedCost: number;
}

/** Full three-session TDD result */
export interface ThreeSessionTddResult {
  /** Overall success */
  success: boolean;
  /** Category of failure (if success is false) */
  failureCategory?: FailureCategory;
  /** Individual session results */
  sessions: TddSessionResult[];
  /** Whether human review is needed */
  needsHumanReview: boolean;
  /** Reason for human review (if needed) */
  reviewReason?: string;
  /** Total cost */
  totalCost: number;
  /** Whether lite mode was used (skips test-writer/implementer isolation) */
  lite: boolean;
}
