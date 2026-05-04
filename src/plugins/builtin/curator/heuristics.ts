/**
 * Curator Heuristics — Phase 2
 *
 * Six deterministic heuristics that convert observations into proposals.
 * Each heuristic is a pure function that groups observations and generates proposals.
 */

import type { Observation } from "./types";

/** Curator threshold configuration */
export interface CuratorThresholds {
  repeatedFinding: number;
  emptyKeyword: number;
  rectifyAttempts: number;
  escalationChain: number;
  staleChunkRuns: number;
  unchangedOutcome: number;
}

/** Proposal target file and action */
export interface ProposalTarget {
  canonicalFile: string;
  action: "add" | "drop" | "advisory";
}

/** Curator proposal output */
export interface Proposal {
  id: "H1" | "H2" | "H3" | "H4" | "H5" | "H6";
  severity: "LOW" | "MED" | "HIGH";
  target: ProposalTarget;
  description: string;
  evidence: string;
  sourceKinds: Observation["kind"][];
  storyIds: string[];
}

/**
 * Run all heuristics on observations.
 *
 * @param observations - Array of observations from a run
 * @param thresholds - Configuration thresholds for heuristics
 * @returns Array of proposals
 */
export function runHeuristics(observations: Observation[], thresholds: CuratorThresholds): Proposal[] {
  // TODO: Implement all 6 heuristics
  return [];
}
