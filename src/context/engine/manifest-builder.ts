/**
 * Manifest assembly for `ContextOrchestrator.assemble()`.
 *
 * Extracted from orchestrator.ts to keep that file under the 600-line limit.
 * Pure — no I/O, no logging, no clock reads; every input is passed in.
 */

import type { PackedChunk } from "./packing";
import type { ContextManifest, ContextRequest } from "./types";

/** Maximum characters of chunk content retained for post-story effectiveness annotation. */
export const CHUNK_SUMMARY_CHARS = 300;

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
  /**
   * Token cost by chunk ID for every scored chunk, included or excluded.
   * buildManifest only receives IDs for the exclusion classes, so this carries
   * their costs onto `chunkTokens` — the evicted-token accounting Finding 5
   * requires. IDs absent from the lookup leave no key.
   */
  chunkTokenLookup: ReadonlyMap<string, number>;
  /** Provider ID by chunk ID for every scored chunk, included or excluded. */
  chunkProviderLookup: ReadonlyMap<string, string>;
  floorPackedIds: string[];
  floorOverageIds: string[];
  /** Sum of the `tokens` of the chunks in `floorOverageIds` (Ruling 11). */
  floorOverageTokens: number;
  /** Effective ceiling actually used by `packChunks` (US-003). */
  effectiveBudget: number;
  /**
   * Set of chunk IDs that the orchestrator classified as stale at assembly
   * time (Amendment A AC-46/47). US-001 attribute: `buildManifest` stamps
   * `stale: true` onto every `excludedChunks` entry whose ID is in this set,
   * preserving the mechanical `reason` alongside the staleness signal.
   *
   * Derived in the orchestrator from `scored`, which is documented as a
   * superset of every chunk that reaches the exclusion lists — so a chunk
   * in any of `roleFiltered`, `belowMin`, `dedupeDropped`, `budgetExcludedIds`
   * is reachable from the set even if it never reached `packed`.
   */
  staleIds: ReadonlySet<string>;
}

/**
 * Build the manifest for one assemble() call.
 *
 * `chunkSummaries`, `chunkTokens`, `chunkScores`, and `staleChunks` are
 * optional and omitted when empty, so an empty bundle does not persist four
 * empty objects.
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
    chunkTokenLookup,
    chunkProviderLookup,
    floorPackedIds,
    floorOverageIds,
    floorOverageTokens,
    effectiveBudget,
    staleIds,
  } = inputs;

  // Amendment A: stale chunk IDs and content summaries for post-story
  // effectiveness annotation. chunkTokens (#1421) lets downstream consumers
  // report a real per-chunk cost instead of a placeholder zero.
  const staleChunkIds = packed.filter((c) => c.staleCandidate).map((c) => c.id);
  const chunkSummaries: Record<string, string> = {};
  const chunkTokens: Record<string, number> = {};
  // US-004: per-chunk final score, keyed by chunk ID for every packed chunk.
  // Persists the effectiveness-weighted score so the written manifest records
  // how a provider weight moved the chunk's score (AC8).
  const chunkScores: Record<string, number> = {};
  // US-002: per-chunk file-scope attribution carrier. Forwarded verbatim
  // from RawChunk.scopePaths onto the persisted manifest so downstream
  // attribution can map chunk IDs back to the files they are scoped to.
  // Built only from chunks that actually carry scopePaths — chunks without
  // it (whole-diff behaviour from non-rules providers) leave no key.
  const chunkScopePaths: Record<string, string[]> = {};
  // US-003: per-chunk provider attribution carrier. Forwarded from
  // PackedChunk.providerId (stamped by enrichRaw() before scoring) so
  // downstream per-provider aggregation has an explicit chunk-ID → provider
  // mapping. Chunks without a providerId leave no key — the manifest records
  // no mapping otherwise, and splitting the chunk ID on ":" is a convention,
  // not an invariant. Null prototype so a provider-controlled chunk ID such
  // as "__proto__" is stored as an ordinary own key rather than setting the
  // prototype (chunk IDs are not trusted input).
  const chunkProviders: Record<string, string> = Object.create(null);
  for (const c of packed) {
    chunkSummaries[c.id] = c.content.slice(0, CHUNK_SUMMARY_CHARS);
    chunkTokens[c.id] = c.tokens;
    chunkScores[c.id] = c.score;
    if (c.scopePaths && c.scopePaths.length > 0) {
      chunkScopePaths[c.id] = c.scopePaths;
    }
    if (c.providerId !== undefined) {
      chunkProviders[c.id] = c.providerId;
    }
  }

  // US-001: stamp `stale` onto every excludedChunks entry uniformly on all
  // four exclusion paths. The mechanical `reason` is preserved unchanged —
  // staleness is an orthogonal axis, not an alternative cause. The flag is
  // stamped on every mapping whether or not the chunk is stale (uniform
  // stamping: production reachability is narrower than the contract).
  const excludedChunks: ContextManifest["excludedChunks"] = [
    ...roleFiltered.map((c) => ({ id: c.id, reason: "role-filter" as const, stale: staleIds.has(c.id) })),
    ...belowMin.map((c) => ({ id: c.id, reason: "below-min-score" as const, stale: staleIds.has(c.id) })),
    ...dedupeDropped.map((id) => ({ id, reason: "dedupe" as const, stale: staleIds.has(id) })),
    ...budgetExcludedIds.map((id) => ({ id, reason: "budget" as const, stale: staleIds.has(id) })),
  ];

  // Finding 5 (#2061): record excluded chunks' token costs too, so the manifest
  // can answer "how many tokens did the budget evict". Only fills keys the
  // lookup knows; included chunks keep the cost from their own PackedChunk.
  for (const { id } of excludedChunks) {
    const tokens = chunkTokenLookup.get(id);
    if (tokens !== undefined && chunkTokens[id] === undefined) {
      chunkTokens[id] = tokens;
    }
    const providerId = chunkProviderLookup.get(id);
    if (providerId !== undefined && chunkProviders[id] === undefined) {
      chunkProviders[id] = providerId;
    }
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
    effectiveBudget,
    usedTokens: usedTokens + priorStageDigestTokens,
    includedChunks: packed.map((c) => c.id),
    excludedChunks,
    floorItems: floorPackedIds,
    floorOverageItems: floorOverageIds.length > 0 ? floorOverageIds : undefined,
    floorOverageTokens: floorOverageIds.length > 0 ? floorOverageTokens : undefined,
    digestTokens,
    buildMs,
    providerResults,
    repoRoot: request.repoRoot,
    packageDir: request.packageDir,
    ...(Object.keys(chunkSummaries).length > 0 && { chunkSummaries }),
    ...(Object.keys(chunkTokens).length > 0 && { chunkTokens }),
    ...(Object.keys(chunkScores).length > 0 && { chunkScores }),
    ...(staleChunkIds.length > 0 && { staleChunks: staleChunkIds }),
    ...(Object.keys(chunkScopePaths).length > 0 && { chunkScopePaths }),
    ...(Object.keys(chunkProviders).length > 0 && { chunkProviders }),
  };
}
