/**
 * Bake-off Ranking
 *
 * Pure, dependency-free ranking logic for contestant results.
 */

import type { ContestantResult } from "./types";

// Only "passed" ranks ahead of the rest; every other status (failed,
// cost-limit, timeout, dnf-crashed, dnf-not-installed, or any unrecognized
// value) shares the same lower tier and is broken by storiesPassed/cost/time.
const STATUS_RANK: Record<string, number> = { passed: 0 };

function rank(status: string): number {
  return STATUS_RANK[status] ?? 1;
}

function safeNum(n: number): number {
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

export function rankContestants(results: ContestantResult[]): ContestantResult[] {
  return [...results].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      safeNum(b.storiesPassed) - safeNum(a.storiesPassed) ||
      safeNum(a.costUsd) - safeNum(b.costUsd) ||
      safeNum(a.wallTimeMs) - safeNum(b.wallTimeMs),
  );
}
