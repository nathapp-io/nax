/**
 * Bake-off Ranking
 *
 * Pure, dependency-free ranking logic for contestant results.
 */

import type { ContestantResult } from "./types";

export function rankContestants(results: ContestantResult[]): ContestantResult[] {
  return [...results].sort(
    (a, b) => b.storiesPassed - a.storiesPassed || a.costUsd - b.costUsd || a.wallTimeMs - b.wallTimeMs,
  );
}
