/**
 * Context Engine v2 — Scoring
 *
 * Adjusts raw provider scores by role match, chunk kind, and freshness.
 * Chunks that fall below minScore after adjustment are dropped (noise filter).
 *
 * Score formula:
 *   adjustedScore = rawScore × roleMultiplier × kindWeight × freshnessMultiplier
 *
 * "static" and "feature" chunks are always floor-included regardless of score —
 * the scorer still computes a score for them so the manifest is accurate.
 */

import type { ChunkKind, ChunkRole, RawChunk } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 0: near-zero threshold so existing chunks are almost never dropped.
 * Post-GA: tuned upward once effectiveness signal is available.
 */
export const MIN_SCORE = 0.1;

/** Kind weights — how much the orchestrator trusts each chunk type */
const KIND_WEIGHTS: Record<ChunkKind, number> = {
  static: 1.0,
  feature: 1.0,
  session: 0.9,
  history: 0.8,
  neighbor: 0.75,
  rag: 0.7,
  graph: 0.7,
  kb: 0.65,
};

/** Role match multipliers */
const ROLE_MATCH_WEIGHT = 1.0;
const ROLE_ALL_WEIGHT = 0.9; // "all" tag matches any caller — slight discount
const ROLE_MISMATCH_WEIGHT = 0.0; // chunk is excluded by role filter, not the scorer

/**
 * Freshness multiplier for stale chunks.
 * Applied when chunk.stale === true (Post-GA signal).
 */
const STALENESS_PENALTY = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Role resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine whether the chunk's audience tags include the caller's role.
 * Returns the appropriate role multiplier.
 */
function roleMultiplier(chunkRoles: ChunkRole[], callerRole: ChunkRole): number {
  if (chunkRoles.includes(callerRole)) return ROLE_MATCH_WEIGHT;
  if (chunkRoles.includes("all")) return ROLE_ALL_WEIGHT;
  return ROLE_MISMATCH_WEIGHT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoredChunk extends RawChunk {
  /** Final score after all adjustments */
  score: number;
  /** True when this chunk was excluded by the role filter (score === 0) */
  roleFiltered: boolean;
  /** True when this chunk is below minScore after adjustment */
  belowMinScore: boolean;
}

/**
 * Score a single raw chunk from a provider.
 *
 * @param chunk - raw chunk from provider
 * @param callerRole - role of the requesting pipeline stage
 * @param minScore - minimum score threshold (from config.context.v2.minScore)
 * @param stale - whether the chunk is detected as stale (Post-GA)
 */
export function scoreChunk(chunk: RawChunk, callerRole: ChunkRole, minScore = MIN_SCORE, stale = false): ScoredChunk {
  const rm = roleMultiplier(chunk.role, callerRole);
  const roleFiltered = rm === 0;

  const kindWeight = KIND_WEIGHTS[chunk.kind] ?? 0.5;
  const freshnessMultiplier = stale ? STALENESS_PENALTY : 1.0;

  const score = chunk.rawScore * rm * kindWeight * freshnessMultiplier;
  const belowMinScore = !roleFiltered && score < minScore;

  return { ...chunk, score, roleFiltered, belowMinScore };
}

/**
 * Score all chunks from all providers.
 * Returns parallel array of ScoredChunks — same order as input.
 *
 * @param chunks - raw chunks to score
 * @param callerRole - role of the requesting pipeline stage
 * @param minScore - minimum score threshold (from config.context.v2.minScore, default: MIN_SCORE)
 */
export function scoreChunks(chunks: RawChunk[], callerRole: ChunkRole, minScore = MIN_SCORE): ScoredChunk[] {
  return chunks.map((c) => scoreChunk(c, callerRole, minScore));
}
