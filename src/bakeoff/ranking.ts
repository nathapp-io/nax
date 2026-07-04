/**
 * Bake-off Ranking
 *
 * Pure, dependency-free ranking logic for contestant results.
 */

import type { ContestantResult } from "./types";

const STATUS_RANK: Record<string, number> = { passed: 0, "dnf-crashed": 1, "dnf-timeout": 1, "dnf-killed": 1 };

function safeNum(n: number): number {
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

export function rankContestants(results: ContestantResult[]): ContestantResult[] {
  return [...results].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      safeNum(b.storiesPassed) - safeNum(a.storiesPassed) ||
      safeNum(a.costUsd) - safeNum(b.costUsd) ||
      safeNum(a.wallTimeMs) - safeNum(b.wallTimeMs),
  );
}
