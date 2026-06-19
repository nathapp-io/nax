/**
 * Execution-layer wrapper types.
 *
 * Owned by the wrapper layer (not src/tdd) — the wrapper produces StoryRunResult
 * from any strategy, and strategy implementations (src/tdd, etc.) are consumers.
 * Per US-005 §5: StoryRunResult is the canonical wrapper-level result.
 */

import type { TokenUsage } from "../agents/cost";
import type { SelfVerificationResult } from "../quality";
import type { VerifierVerdict } from "../tdd/verdict";

/** Session role for TDD strategies. */
export type TddSessionRole = "test-writer" | "implementer" | "verifier";

/** Failure categories for story-run results. */
export type FailureCategory =
  /** Test-writer violated file isolation or created no test files */
  | "isolation-violation"
  /** A session crashed, timed out, or the agent failed to produce usable output */
  | "session-failure"
  /** Tests were written and implemented but still fail after all sessions */
  | "tests-failing"
  /** Full-suite gate failed and rectification retries exhausted before verifier */
  | "full-suite-gate-exhausted"
  /** Verifier explicitly rejected the implementation */
  | "verifier-rejected"
  /** Greenfield project with no test files — TDD not applicable (BUG-010) */
  | "greenfield-no-tests"
  /** A configured review phase (semantic / adversarial) never ran before the verdict */
  | "review-incomplete"
  /** Worktree dependency preparation failed before pipeline execution started */
  | "dependency-prep"
  | "runtime-crash";

/** Isolation verification result. */
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

/** Result of a single session within a story run (typically TDD-shaped). */
export interface TddSessionResult {
  role: TddSessionRole;
  success: boolean;
  isolation?: IsolationCheck;
  estimatedCostUsd: number;
  tokenUsage?: TokenUsage;
  filesChanged: string[];
  durationMs: number;
  branch?: string;
  timestamp?: string;
  error?: string;
  outputTail?: string;
  selfVerification?: SelfVerificationResult;
  tests?: {
    total: number;
    passed: number;
    failed: number;
  };
}

/** Wrapper-level result of a story run. Owned by the execution wrapper layer. */
export interface StoryRunResult {
  success: boolean;
  sessions: TddSessionResult[];
  needsHumanReview: boolean;
  reviewReason?: string;
  totalCost: number;
  totalTokenUsage?: TokenUsage;
  totalDurationMs?: number;
  lite: boolean;
  failureCategory?: FailureCategory;
  /**
   * Verifier verdict parsed from .nax-verifier-verdict.json (for logging/debugging).
   * null      = verdict file was missing or malformed (no verdict available)
   * undefined = verdict was not attempted (e.g. early-exit before session 3 ran)
   */
  verdict?: VerifierVerdict | null;
  /** Whether the TDD full-suite gate passed (used by verify stage to skip redundant run, BUG-054) */
  fullSuiteGatePassed?: boolean;
}
