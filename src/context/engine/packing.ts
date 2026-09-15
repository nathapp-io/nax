/**
 * Context Engine v2 — Greedy Packing + Repair
 *
 * Selects which chunks fit within the token budget.
 *
 * Phase 0-2: Greedy algorithm — sort by score/tokens (density) descending and
 * pack floor items (static + feature + test-coverage kinds) regardless of
 * budget. Exception: when the non-floor guarantee fires (below), guaranteed
 * non-floor chunks are packed before the floor, so floor items are not always
 * first.
 *
 * Budget floor rule (spec §AC-6):
 *   "static", "feature", and "test-coverage" chunks are always included
 *   even when their total tokens exceed budgetTokens. The manifest records
 *   reason: "budget-exceeded-by-floor" for any chunk that causes an overflow.
 *   When the floor alone overflows the effective budget, up to
 *   NON_FLOOR_GUARANTEE (3) non-floor chunks by density are admitted first —
 *   skipping any candidate whose tokens exceed the effective budget — and the
 *   floor then packs unconditionally.
 *
 * Non-floor optimality repair (spec §AC-7, US-004):
 *   Density-greedy is the standard heuristic for fractional knapsack, but
 *   for the 0/1 case (chunks are atomic — no partial packing) it can fall
 *   arbitrarily far from the optimum (e.g. one huge high-density chunk that
 *   excludes many smaller lower-density ones which would sum to more value).
 *   The standard "best-of(greedy, largest feasible single item)" repair
 *   applied below is a **½-approximation**: at least half the optimum in
 *   general, and exactly optimal inside the envelope AC-4's property test
 *   covers — every item fits, or one feasible item is the optimum.
 *
 *   It is NOT a 5%-of-optimal guarantee. Outside that envelope the shortfall
 *   approaches 50%: A(51 tok, score 52), B(50, 50), C(50, 50) at budget 100
 *   packs [A] = 52 against an optimum of [B, C] = 100. That is accepted, not
 *   overlooked — real candidate sets are 5–20 chunks with no adversarial
 *   structure, and closing the gap means exact 0/1 DP (deferred to Phase 3+).
 *   See `packChunks — documented approximation bound` in packing.test.ts.
 *
 *   Applied to the non-floor pass only — floor chunks are exempt from the
 *   budget and remain greedy/floor-included.
 */

import type { ScoredChunk } from "./scoring";
import type { ChunkKind } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Chunk kinds that are always included (budget floor) */
export const FLOOR_KINDS: ChunkKind[] = ["static", "feature", "test-coverage"];

/**
 * Maximum number of non-floor chunks force-admitted when the budget floor
 * alone overflows the effective budget (Ruling 8, #2061(c)). The floor
 * exemption concedes the whole budget, so this guarantees repo-derived
 * (non-floor) context a slot. Exported so the ruling's revisit condition can
 * tune it.
 */
export const NON_FLOOR_GUARANTEE = 3;

/**
 * Score per token — the packing priority metric (spec §AC-7). A zero-token
 * chunk has no cost, so it is ranked as maximally dense rather than
 * producing NaN/Infinity from a bare division.
 */
function scoreDensity(chunk: ScoredChunk): number {
  return chunk.tokens > 0 ? chunk.score / chunk.tokens : Number.POSITIVE_INFINITY;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PackedChunk extends ScoredChunk {
  /** Populated when chunk caused budget to overflow (floor-forced inclusion) */
  reason?: string;
}

export interface PackResult {
  /** Chunks that were packed (floor items + greedy-selected items) */
  packed: PackedChunk[];
  /** IDs of chunks excluded due to budget */
  budgetExcludedIds: string[];
  /** Total tokens used by packed chunks */
  usedTokens: number;
  /** Effective budget ceiling used (min of budgetTokens, availableBudgetTokens) */
  effectiveBudget: number;
  /** IDs of ALL floor-kind chunks that were packed (static, feature, test-coverage) */
  floorPackedIds: string[];
  /** IDs of floor-kind chunks that caused the budget to be exceeded (subset of floorPackedIds) */
  floorOverageIds: string[];
  /** Sum of the `tokens` of the chunks listed in `floorOverageIds` (Ruling 11) */
  floorOverageTokens: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-floor patch helpers (US-004)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Greedy by density — fill the remaining budget with the highest-density
 * non-floor chunks first. Returns the selected chunks in selected order and
 * the leftover IDs.
 */
function greedyNonFloor(
  nonFloor: ScoredChunk[],
  remainingBudget: number,
): { selected: ScoredChunk[]; excludedIds: string[] } {
  const sorted = [...nonFloor].sort((a, b) => scoreDensity(b) - scoreDensity(a));
  const selected: ScoredChunk[] = [];
  const excludedIds: string[] = [];
  let used = 0;
  for (const chunk of sorted) {
    if (used + chunk.tokens <= remainingBudget) {
      selected.push(chunk);
      used += chunk.tokens;
    } else {
      excludedIds.push(chunk.id);
    }
  }
  return { selected, excludedIds };
}

/**
 * Largest single item that fits — the AC-7 repair candidate. Among
 * non-floor chunks that fit alone in the remaining budget, pick the one
 * with the highest score. Returns an empty array if nothing fits.
 */
function largestSingleItem(nonFloor: ScoredChunk[], remainingBudget: number): ScoredChunk[] {
  let best: ScoredChunk | null = null;
  for (const chunk of nonFloor) {
    if (chunk.tokens > remainingBudget) continue;
    if (best === null || chunk.score > best.score) best = chunk;
  }
  return best ? [best] : [];
}

/**
 * Best-of(greedy, largest single item) repair (spec §AC-7, US-004 AC-26).
 * Picks the candidate with the highest total score. Ties keep the greedy
 * result. The greedy candidate is returned in density order; the rebuild path
 * normalizes selected chunks to prior order when it needs stable emission.
 */
function repairNonFloor(
  nonFloor: ScoredChunk[],
  remainingBudget: number,
): { selected: ScoredChunk[]; excludedIds: string[] } {
  const greedy = greedyNonFloor(nonFloor, remainingBudget);
  const greedyScore = greedy.selected.reduce((s, c) => s + c.score, 0);

  const largest = largestSingleItem(nonFloor, remainingBudget);
  const largestScore = largest.reduce((s, c) => s + c.score, 0);

  // Pick the best between greedy and the largest feasible single item.
  const candidates: Array<{ selected: ScoredChunk[]; totalScore: number }> = [
    { selected: greedy.selected, totalScore: greedyScore },
    { selected: largest, totalScore: largestScore },
  ];
  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.totalScore > best.totalScore) {
      best = candidate;
    }
  }

  const winnerIds = new Set(best.selected.map((c) => c.id));
  const excludedIds = nonFloor.filter((c) => !winnerIds.has(c.id)).map((c) => c.id);
  return { selected: best.selected, excludedIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Packing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Greedy packing with budget floor and non-floor optimality repair.
 *
 * @param chunks - de-duped, scored chunks (excludes role-filtered + below-min-score)
 * @param budgetTokens - token budget from ContextRequest
 * @param availableBudgetTokens - remaining context window (optional ceiling)
 */
export function packChunks(chunks: ScoredChunk[], budgetTokens: number, availableBudgetTokens?: number): PackResult {
  const effectiveBudget =
    availableBudgetTokens !== undefined ? Math.min(budgetTokens, availableBudgetTokens) : budgetTokens;

  const floorChunks = chunks.filter((c) => FLOOR_KINDS.includes(c.kind));
  const nonFloorChunks = chunks.filter((c) => !FLOOR_KINDS.includes(c.kind));

  const packed: PackedChunk[] = [];
  const floorPackedIds: string[] = [];
  const floorOverageIds: string[] = [];
  let floorOverageTokens = 0;
  let usedTokens = 0;

  // Determine whether the floor pass collectively overflows the effective
  // budget. This gates the non-floor guarantee (Pass 0) only. Overage
  // ATTRIBUTION is per-chunk and cumulative (Ruling 11): a floor chunk is
  // overage iff `usedTokens + chunk.tokens > effectiveBudget` at the point it
  // is packed — so a floor chunk that fits before a later one pushes the
  // bundle over is NOT itself overage.
  const totalFloorTokens = floorChunks.reduce((sum, c) => sum + c.tokens, 0);
  const floorCollectivelyOverflows = totalFloorTokens > effectiveBudget;

  // Pass 0: non-floor guarantee — only when the floor alone overflows the
  // budget. Admit the highest-density non-floor chunks first (skipping any
  // chunk too large to ever fit) so repo-derived context cannot be starved by
  // the conceded floor exemption.
  const guaranteedIds = new Set<string>();
  if (floorCollectivelyOverflows) {
    const byDensity = [...nonFloorChunks].sort((a, b) => scoreDensity(b) - scoreDensity(a));
    for (const chunk of byDensity) {
      if (guaranteedIds.size >= NON_FLOOR_GUARANTEE) break;
      if (chunk.tokens > effectiveBudget) continue;
      guaranteedIds.add(chunk.id);
      packed.push({ ...chunk });
      usedTokens += chunk.tokens;
    }
  }

  // Pass 1: floor items — always include, regardless of budget. Overage is
  // attributed cumulatively: only the chunk that crosses the ceiling at the
  // point it is packed is overage.
  for (const chunk of floorChunks) {
    const overflows = usedTokens + chunk.tokens > effectiveBudget;
    const packedChunk: PackedChunk = { ...chunk };
    if (overflows) {
      packedChunk.reason = "budget-exceeded-by-floor";
      floorOverageIds.push(chunk.id);
      floorOverageTokens += chunk.tokens;
    }
    floorPackedIds.push(chunk.id);
    packed.push(packedChunk);
    usedTokens += chunk.tokens;
  }

  // Pass 2: remaining non-floor items — best-of(greedy, largest single) repair
  const remainingNonFloor = nonFloorChunks.filter((c) => !guaranteedIds.has(c.id));
  const remainingBudget = Math.max(0, effectiveBudget - usedTokens);
  const { selected, excludedIds } = repairNonFloor(remainingNonFloor, remainingBudget);
  for (const chunk of selected) {
    packed.push({ ...chunk });
    usedTokens += chunk.tokens;
  }

  return {
    packed,
    budgetExcludedIds: excludedIds,
    usedTokens,
    effectiveBudget,
    floorPackedIds,
    floorOverageIds,
    floorOverageTokens,
  };
}
