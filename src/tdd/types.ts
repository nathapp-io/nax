import type { Story } from "../execution/types";

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
  /** Whether isolation passed (no illegal files modified) */
  passed: boolean;
  /** Files modified by the agent */
  filesModified: string[];
  /** Expected test files (writer only) */
  testFilesExpected?: string[];
  /** Illegal files modified (not tests/new) */
  illegalFilesModified: string[];
}

/** Result of a single TDD session */
export interface TddSessionResult {
  /** Session role */
  role: TddSessionRole;
  /** Whether session completed successfully */
  success: boolean;
  /** Git branch created/used */
  branch: string;
  /** ISO timestamp */
  timestamp: string;
  /** Error message (if success=false) */
  error?: string;
  /** Isolation check results (if applicable) */
  isolation?: IsolationCheck;
  /** Cost of this session (USD) */
  cost: number;
  /** Number of tests written/passed/failed */
  tests?: {
    total: number;
    passed: number;
    failed: number;
  };
}

/** Result of a three-session TDD orchestration */
export interface ThreeSessionTddResult {
  /** Overall success */
  success: boolean;
  /** Individual session results */
  sessions: TddSessionResult[];
  /** Whether human review is needed */
  needsHumanReview: boolean;
  /** Reason for review (if any) */
  reviewReason?: string;
  /** Total cost of all sessions (USD) */
  totalCost: number;
  /** Whether lite mode was used (skips test-writer/implementer isolation) */
  lite: boolean;
  /** Category of failure (if success is false) */
  failureCategory?: FailureCategory;
}
