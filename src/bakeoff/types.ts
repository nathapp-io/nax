/**
 * Bake-off Types
 *
 * Pure types for cross-agent contestant comparison and ranking.
 */

export type ContestantStatus = "passed" | "failed" | "dnf-crashed" | "dnf-not-installed" | "cost-limit" | "timeout";

export interface ContestantResult {
  /** Optional human-readable label; the agent name is the stable identifier. */
  name?: string;
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
  /** Winner — set only when ranking[0] actually finished (not a DNF). */
  winner?: ContestantResult;
  /** Raw collected results in input order (pre-ranking). */
  contestants: ContestantResult[];
  /** Process exit outcome: 0 = at least one finisher, non-zero = all DNFs. */
  outcome: number;
  /** Contestants dropped at pre-flight (unknown agent, no adapter, not installed). */
  validationErrors?: Array<{ agent: string; reason: string }>;
}
