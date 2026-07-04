/**
 * Bake-off Types
 *
 * Pure types for cross-agent contestant comparison and ranking.
 */

export type ContestantStatus = "passed" | "dnf-crashed" | "dnf-timeout" | "dnf-killed";

export interface ContestantResult {
  name: string;
  agent: string;
  status: ContestantStatus;
  storiesPassed: number;
  costUsd: number;
  wallTimeMs: number;
  error?: string;
}

export interface BakeoffResult {
  contestants: ContestantResult[];
  winner?: ContestantResult;
  completedAt: string;
}
