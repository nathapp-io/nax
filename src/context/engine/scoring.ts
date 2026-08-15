/**
 * Context Engine v2 — Scoring
 *
 * Adjusts raw provider scores by role match, chunk kind, and freshness.
 * Chunks that fall below minScore after adjustment are dropped (noise filter).
 *
 * Score formula:
 *   adjustedScore = rawScore × roleMultiplier × kindWeight × freshnessMultiplier × effectivenessMultiplier
 *
 * The effectiveness multiplier is caller-derived (US-004): when a
 * `providerWeights` map keys the chunk's `providerId`, the score is multiplied
 * by that weight; otherwise it is identity (1.0).
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
  "test-coverage": 1.0,
  diagnostics: 0.95, // US-002: authoritative tool diagnostics — the most actionable context a rectifier can receive
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
 * @param providerWeights - per-provider effectiveness weights keyed by chunk.providerId (US-004).
 *                          When the key is absent, the weight is treated as 1.0 (identity).
 */
export function scoreChunk(
  chunk: RawChunk,
  callerRole: ChunkRole,
  minScore = MIN_SCORE,
  stale = false,
  providerWeights?: Record<string, number>,
): ScoredChunk {
  const rm = roleMultiplier(chunk.role, callerRole);
  const roleFiltered = rm === 0;

  const kindWeight = KIND_WEIGHTS[chunk.kind] ?? 0.5;
  // Amendment A AC-46: staleCandidate on chunk overrides the caller-supplied stale flag.
  // scoreMultiplier from the chunk (set by FeatureContextProviderV2) takes precedence
  // over the global STALENESS_PENALTY so config.staleness.scoreMultiplier is respected.
  const isStale = chunk.staleCandidate === true || stale;
  const freshnessMultiplier = isStale ? (chunk.scoreMultiplier ?? STALENESS_PENALTY) : 1.0;

  // US-004: caller-derived effectiveness multiplier keyed on chunk.providerId.
  // Identity (1.0) when the chunk carries no providerId or the map omits it.
  const effectivenessMultiplier = chunk.providerId !== undefined ? (providerWeights?.[chunk.providerId] ?? 1.0) : 1.0;

  const score = chunk.rawScore * rm * kindWeight * freshnessMultiplier * effectivenessMultiplier;
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
 * @param providerWeights - per-provider effectiveness weights threaded to scoreChunk (US-004)
 */
export function scoreChunks(
  chunks: RawChunk[],
  callerRole: ChunkRole,
  minScore = MIN_SCORE,
  providerWeights?: Record<string, number>,
): ScoredChunk[] {
  return chunks.map((c) => scoreChunk(c, callerRole, minScore, false, providerWeights));
}
