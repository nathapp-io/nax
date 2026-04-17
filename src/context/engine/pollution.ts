/**
 * Context Engine v2 — Pollution Metrics
 *
 * Aggregates context pollution indicators from stored manifests (Amendment A AC-48).
 * Pure function — no I/O. Called from deriveContextMetrics in metrics/tracker.ts.
 *
 * Pollution metrics:
 *   droppedBelowMinScore  — chunks excluded by noise gate
 *   staleChunksInjected   — chunks that were stale but still included (downweighted)
 *   contradictedChunks    — included chunks whose advice review findings contradicted
 *   ignoredChunks         — included chunks that the agent apparently ignored
 *   pollutionRatio        — (contradicted + ignored) / total included
 *
 * See: docs/specs/SPEC-context-engine-v2-amendments.md Amendment A.4
 */

import type { StoredContextManifest } from "./manifest-store";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PollutionMetrics {
  droppedBelowMinScore: number;
  staleChunksInjected: number;
  contradictedChunks: number;
  ignoredChunks: number;
  pollutionRatio: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute aggregate pollution metrics across all stored manifests for a story.
 *
 * - droppedBelowMinScore: sum of excludedChunks with reason "below-min-score"
 * - staleChunksInjected: sum of staleChunks[] entries (included stale chunks)
 * - contradictedChunks: sum of chunkEffectiveness entries with signal "contradicted"
 * - ignoredChunks: sum of chunkEffectiveness entries with signal "ignored"
 * - pollutionRatio: (contradicted + ignored) / max(totalIncluded, 1)
 */
export function computePollutionMetrics(manifests: StoredContextManifest[]): PollutionMetrics {
  let droppedBelowMinScore = 0;
  let staleChunksInjected = 0;
  let contradictedChunks = 0;
  let ignoredChunks = 0;
  let totalIncluded = 0;

  for (const { manifest } of manifests) {
    for (const ex of manifest.excludedChunks) {
      if (ex.reason === "below-min-score") droppedBelowMinScore++;
    }

    staleChunksInjected += manifest.staleChunks?.length ?? 0;
    totalIncluded += manifest.includedChunks.length;

    if (manifest.chunkEffectiveness) {
      for (const signal of Object.values(manifest.chunkEffectiveness)) {
        if (signal.signal === "contradicted") contradictedChunks++;
        else if (signal.signal === "ignored") ignoredChunks++;
      }
    }
  }

  const pollutionRatio = totalIncluded > 0 ? (contradictedChunks + ignoredChunks) / totalIncluded : 0;

  return {
    droppedBelowMinScore,
    staleChunksInjected,
    contradictedChunks,
    ignoredChunks,
    pollutionRatio,
  };
}
