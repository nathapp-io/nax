/**
 * Context Engine v2 — Deduplication
 *
 * Removes near-duplicate chunks before packing.
 * Two chunks are considered duplicates when their normalized content
 * similarity is >= SIMILARITY_THRESHOLD.
 *
 * Algorithm (Phase 0): character-level Jaccard similarity on trigrams.
 * Simple, deterministic, and fast for the chunk sizes we deal with.
 * Phase 3+: replace with embedding-based cosine similarity if needed.
 */

import type { ScoredChunk } from "./scoring";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Chunks with similarity >= this threshold are considered duplicates. */
export const SIMILARITY_THRESHOLD = 0.9;

// ─────────────────────────────────────────────────────────────────────────────
// Trigram similarity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a set of character trigrams from a string.
 * Normalizes whitespace before building to avoid spurious mismatches.
 */
function trigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const result = new Set<string>();
  for (let i = 0; i + 2 < normalized.length; i++) {
    result.add(normalized.slice(i, i + 3));
  }
  return result;
}

/**
 * Jaccard similarity between two trigram sets.
 * Returns 1.0 when both sets are empty (two empty-content chunks are identical).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication
// ─────────────────────────────────────────────────────────────────────────────

export interface DedupeResult {
  /** Chunks that survived deduplication, highest-score representative kept */
  kept: ScoredChunk[];
  /** IDs of chunks that were dropped as duplicates */
  droppedIds: string[];
}

/**
 * Deduplicate scored chunks by content similarity.
 *
 * For each group of near-duplicate chunks, keep the one with the highest score.
 * When scores are equal, keep the one that appears first (stable).
 *
 * Input chunks should already be sorted by score descending so that the
 * highest-score representative is encountered first.
 */
export function dedupeChunks(chunks: ScoredChunk[]): DedupeResult {
  const kept: ScoredChunk[] = [];
  const keptTrigrams: Set<string>[] = [];
  const droppedIds: string[] = [];

  for (const chunk of chunks) {
    const ct = trigrams(chunk.content);
    let isDuplicate = false;

    for (const kt of keptTrigrams) {
      if (jaccardSimilarity(ct, kt) >= SIMILARITY_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) {
      droppedIds.push(chunk.id);
    } else {
      kept.push(chunk);
      keptTrigrams.push(ct);
    }
  }

  return { kept, droppedIds };
}
