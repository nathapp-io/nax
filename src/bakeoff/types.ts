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
  contestants: ContestantResult[];
  winner?: ContestantResult;
  completedAt: string;
}
