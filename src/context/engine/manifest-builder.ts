/**
 * Manifest assembly for `ContextOrchestrator.assemble()`.
 *
 * Extracted from orchestrator.ts to keep that file under the 600-line limit.
 * Pure — no I/O, no logging, no clock reads; every input is passed in.
 */

import type { PackedChunk } from "./packing";
import type { ContextBundle, ContextManifest, ContextRequest } from "./types";

/** Maximum characters of chunk content retained for post-story effectiveness annotation. */
const CHUNK_SUMMARY_CHARS = 300;

/** Everything assemble() has computed by the time the manifest is built. */
export interface ManifestInputs {
  requestId: string;
  request: ContextRequest;
  packed: PackedChunk[];
  usedTokens: number;
  digestTokens: number;
  buildMs: number;
  providerResults: NonNullable<ContextManifest["providerResults"]>;
  roleFiltered: Array<{ id: string }>;
  belowMin: Array<{ id: string }>;
  dedupeDropped: string[];
  budgetExcludedIds: string[];
  floorPackedIds: string[];
  floorOverageIds: string[];
}

/**
 * Build the manifest for one assemble() call.
 *
 * `chunkSummaries`, `chunkTokens`, and `staleChunks` are optional and omitted
 * when empty, so an empty bundle does not persist three empty objects.
 */
export function buildManifest(inputs: ManifestInputs): ContextManifest {
  const {
    requestId,
    request,
    packed,
    usedTokens,
    digestTokens,
    buildMs,
    providerResults,
    roleFiltered,
    belowMin,
    dedupeDropped,
    budgetExcludedIds,
    floorPackedIds,
    floorOverageIds,
  } = inputs;

  // Amendment A: stale chunk IDs and content summaries for post-story
  // effectiveness annotation. chunkTokens (#1421) lets downstream consumers
  // report a real per-chunk cost instead of a placeholder zero.
  const staleChunkIds = packed.filter((c) => c.staleCandidate).map((c) => c.id);
  const chunkSummaries: Record<string, string> = {};
  const chunkTokens: Record<string, number> = {};
  for (const c of packed) {
    chunkSummaries[c.id] = c.content.slice(0, CHUNK_SUMMARY_CHARS);
    chunkTokens[c.id] = c.tokens;
  }

  // US-001: manifest.usedTokens accounts the digest actually carried in the
  // rendered prompt (request.priorStageDigest). The produced digest is recorded
  // separately in `digestTokens` and threaded forward to the next stage.
  // renderChunks omits a whitespace-only priorStageDigest (it requires .trim()
  // to be non-empty), so buildManifest must match that to keep AC-6 truthful.
  const priorStageDigest = request.priorStageDigest?.trim();
  const priorStageDigestTokens = priorStageDigest ? Math.ceil(priorStageDigest.length / 4) : 0;

  return {
    requestId,
    stage: request.stage,
    totalBudgetTokens: request.budgetTokens,
    usedTokens: usedTokens + priorStageDigestTokens,
    includedChunks: packed.map((c) => c.id),
    excludedChunks: [
      ...roleFiltered.map((c) => ({ id: c.id, reason: "role-filter" as const })),
      ...belowMin.map((c) => ({ id: c.id, reason: "below-min-score" as const })),
      ...dedupeDropped.map((id) => ({ id, reason: "dedupe" as const })),
      ...budgetExcludedIds.map((id) => ({ id, reason: "budget" as const })),
    ],
    floorItems: floorPackedIds,
    floorOverageItems: floorOverageIds.length > 0 ? floorOverageIds : undefined,
    digestTokens,
    buildMs,
    providerResults,
    repoRoot: request.repoRoot,
    packageDir: request.packageDir,
    ...(Object.keys(chunkSummaries).length > 0 && { chunkSummaries }),
    ...(Object.keys(chunkTokens).length > 0 && { chunkTokens }),
    ...(staleChunkIds.length > 0 && { staleChunks: staleChunkIds }),
  };
}

/**
 * Compute the rebuilt manifest's `usedTokens` under US-001 accounting.
 *
 * `usedTokens = packed chunk tokens + prior-digest tokens`. The rebuild keeps
 * the prior's prior-digest contribution unless `newPriorStageDigest` is supplied
 * (then it replaces the prior's contribution).
 *
 * `extraTokens` is the sum of tokens for chunks added by the rebuild that
 * weren't in the prior bundle (typically the failure-note chunk on agent swap).
 */
export function rebuildUsedTokens(
  prior: ContextBundle,
  packed: PackedChunk[],
  newPriorStageDigest: string | undefined,
): number {
  const priorChunksTokens = prior.chunks.reduce((sum, c) => sum + c.tokens, 0);
  const extraTokens = packed
    .filter((c) => !prior.chunks.some((pc) => pc.id === c.id))
    .reduce((sum, c) => sum + c.tokens, 0);
  const packedTokens = priorChunksTokens + extraTokens;
  const priorDigestContribution = Math.max(0, prior.manifest.usedTokens - priorChunksTokens);
  const newDigestContent = newPriorStageDigest?.trim();
  const newDigestContribution = newDigestContent ? Math.ceil(newDigestContent.length / 4) : 0;
  return Math.max(0, packedTokens + (newDigestContribution > 0 ? newDigestContribution : priorDigestContribution));
}
