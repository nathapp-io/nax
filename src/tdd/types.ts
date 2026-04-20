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
  | "verifier-rejected"
  /** Greenfield project with no test files — TDD not applicable (BUG-010) */
  | "greenfield-no-tests"
  /** Worktree dependency preparation failed before pipeline execution started */
  | "dependency-prep"
  | "runtime-crash";

/** Isolation verification result */
export interface IsolationCheck {
  /** Whether isolation passed (no hard violations) */
  passed: boolean;
  /** Hard violation files (files that must not be modified) */
  violations: string[];
  /** Soft violation files (allowed-path overrides, warning only) */
  softViolations?: string[];
  /** Warning files (e.g., implementer touching test files slightly) */
  warnings?: string[];
  /** Human-readable description of what was checked */
  description?: string;
}

/** Result of a single TDD session */
export interface TddSessionResult {
  /** Session role */
  role: TddSessionRole;
  /** Whether session completed successfully */
  success: boolean;
  /** Isolation check results (if applicable) */
  isolation?: IsolationCheck;
  /** Cost of this session (USD) */
  estimatedCost: number;
  /**
   * Token usage for this session (fixes #590).
   * Undefined when the adapter did not report usage (e.g. pre-first-turn
   * failure, or a mock adapter in tests).
   */
  tokenUsage?: import("../agents/cost").TokenUsage;
  /** Files changed by this session (from git diff) */
  filesChanged: string[];
  /** Duration of this session in milliseconds */
  durationMs: number;
  /** Git branch created/used (optional legacy field) */
  branch?: string;
  /** ISO timestamp (optional legacy field) */
  timestamp?: string;
  /** Error message (if success=false) */
  error?: string;
  /** Tail of the agent output for cross-session continuity/debugging */
  outputTail?: string;
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
  /** Total token usage summed across all sessions (fixes #590). Undefined when no session reported usage. */
  totalTokenUsage?: import("../agents/cost").TokenUsage;
  /** Total wall-clock duration of all sessions in milliseconds (sum of session durationMs). */
  totalDurationMs?: number;
  /** Whether lite mode was used (skips test-writer/implementer isolation) */
  lite: boolean;
  /** Category of failure (if success is false) */
  failureCategory?: FailureCategory;
  /**
   * Verifier verdict parsed from .nax-verifier-verdict.json (for logging/debugging).
   * null      = verdict file was missing or malformed (no verdict available)
   * undefined = verdict was not attempted (e.g. early-exit before session 3 ran)
   */
  verdict?: import("./verdict").VerifierVerdict | null;
  /** Whether the TDD full-suite gate passed (used by verify stage to skip redundant run, BUG-054) */
  fullSuiteGatePassed?: boolean;
}
