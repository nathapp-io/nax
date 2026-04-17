/**
 * Context Engine v2 — Greedy Packing
 *
 * Selects which chunks fit within the token budget.
 *
 * Phase 0-2: Greedy algorithm — sort by score descending, always include
 * floor items (static + feature kinds) first regardless of budget.
 *
 * Budget floor rule (spec §AC-6):
 *   "static" and "feature" chunks are always included even when their total
 *   tokens exceed budgetTokens. The manifest records reason:
 *   "budget-exceeded-by-floor" for any chunk that causes an overflow.
 *
 * Phase 3+: Optional 0/1 knapsack DP (in packing.ts) if greedy proves
 * suboptimal. Floor rule still applies in Phase 3+.
 */

import type { ScoredChunk } from "./scoring";
import type { ChunkKind } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Chunk kinds that are always included (budget floor) */
const FLOOR_KINDS: ChunkKind[] = ["static", "feature"];

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
  /** IDs of ALL floor-kind chunks that were packed (static + feature) */
  floorPackedIds: string[];
  /** IDs of floor-kind chunks that caused the budget to be exceeded (subset of floorPackedIds) */
  floorOverageIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Packing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Greedy packing with budget floor.
 *
 * @param chunks - de-duped, scored chunks (excludes role-filtered + below-min-score)
 * @param budgetTokens - token budget from ContextRequest
 * @param availableBudgetTokens - remaining context window (optional ceiling)
 */
export function packChunks(chunks: ScoredChunk[], budgetTokens: number, availableBudgetTokens?: number): PackResult {
  const effectiveBudget =
    availableBudgetTokens !== undefined ? Math.min(budgetTokens, availableBudgetTokens) : budgetTokens;

  const floorChunks = chunks.filter((c) => FLOOR_KINDS.includes(c.kind));
  const nonFloorChunks = chunks.filter((c) => !FLOOR_KINDS.includes(c.kind)).sort((a, b) => b.score - a.score);

  const packed: PackedChunk[] = [];
  const budgetExcludedIds: string[] = [];
  const floorPackedIds: string[] = [];
  const floorOverageIds: string[] = [];
  let usedTokens = 0;

  // Pass 1: floor items — always include
  for (const chunk of floorChunks) {
    const overflows = usedTokens + chunk.tokens > effectiveBudget;
    const packedChunk: PackedChunk = { ...chunk };
    if (overflows) {
      packedChunk.reason = "budget-exceeded-by-floor";
      floorOverageIds.push(chunk.id);
    }
    floorPackedIds.push(chunk.id);
    packed.push(packedChunk);
    usedTokens += chunk.tokens;
  }

  // Pass 2: non-floor items — greedy by score
  for (const chunk of nonFloorChunks) {
    if (usedTokens + chunk.tokens <= effectiveBudget) {
      packed.push({ ...chunk });
      usedTokens += chunk.tokens;
    } else {
      budgetExcludedIds.push(chunk.id);
    }
  }

  return { packed, budgetExcludedIds, usedTokens, effectiveBudget, floorPackedIds, floorOverageIds };
}
