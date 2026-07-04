/**
 * Bake-off Types
 *
 * Pure types for cross-agent contestant comparison and ranking.
 */

export type ContestantStatus =
  | "passed"
  | "failed"
  | "dnf-crashed"
  | "dnf-timeout"
  | "dnf-killed"
  | "cost-limit"
  | "timeout";

export interface ContestantResult {
  name: string;
  agent: string;
  status: ContestantStatus;
  storiesPassed: number;
  costUsd: number;
  wallTimeMs: number;
  tierEscalations?: number;
  storiesTotal?: number;
  error?: string;
}

export interface BakeoffResult {
  feature: string;
  /** Ranked contestant results — index 0 is the winner. */
  ranking: ContestantResult[];
  /** ISO timestamp marking bake-off completion. */
  completedAt: string;
  /** Optional winner — convenience accessor for ranking[0]. */
  winner?: ContestantResult;
  /** Raw collected results in input order (pre-ranking). */
  contestants: ContestantResult[];
  /** Process exit outcome: 0 = at least one finisher, non-zero = all DNFs. */
  outcome: number;
}
