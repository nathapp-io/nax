import type { TddSessionResult } from "../tdd/types";
import type { FailureCategory } from "../tdd/types";

/** Wrapper-level result of a story run. Owned by the execution wrapper layer. */
export interface StoryRunResult {
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
  verdict?: import("../tdd/verdict").VerifierVerdict | null;
  /** Whether the TDD full-suite gate passed (used by verify stage to skip redundant run, BUG-054) */
  fullSuiteGatePassed?: boolean;
}
