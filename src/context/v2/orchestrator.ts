/**
 * Context Engine v2 — ContextOrchestrator
 *
 * Central coordinator for context assembly.  Pipeline stages call assemble()
 * to get a ContextBundle; the orchestrator fetches from providers in parallel,
 * scores, dedupes, packs, renders, and builds a digest.
 *
 * rebuildForAgent() re-renders from prior.chunks without calling providers —
 * used on agent availability fallback (Phase 5.5) to keep context intact
 * when swapping to a different agent profile.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §ContextOrchestrator
 */

import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../config/types";
import { getLogger } from "../../logger";
import type { UserStory } from "../../prd";
import { errorMessage } from "../../utils/errors";
import { dedupeChunks } from "./dedupe";
import { buildDigest, digestTokens } from "./digest";
import { packChunks } from "./packing";
import type { PackedChunk } from "./packing";
import { CodeNeighborProvider } from "./providers/code-neighbor";
import { FeatureContextProviderV2 } from "./providers/feature-context";
import { GitHistoryProvider } from "./providers/git-history";
import { SessionScratchProvider } from "./providers/session-scratch";
import { StaticRulesProvider } from "./providers/static-rules";
import { renderChunks } from "./render";
import { MIN_SCORE, scoreChunks } from "./scoring";
import { getStageContextConfig } from "./stage-config";
import type {
  ContextBundle,
  ContextChunk,
  ContextManifest,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
  RawChunk,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _orchestratorDeps = {
  now: () => Date.now(),
  uuid: () => randomUUID(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Provider fetch timeout
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_FETCH_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(provider: IContextProvider, request: ContextRequest): Promise<ContextProviderResult> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ContextProviderResult>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`Provider "${provider.id}" timed out`)), PROVIDER_FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([provider.fetch(request), timeout]);
  } finally {
    clearTimeout(handle);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk → ContextChunk conversion
// ─────────────────────────────────────────────────────────────────────────────

function toContextChunk(packed: PackedChunk): ContextChunk {
  // providerId is set by enrichRaw() in the orchestrator before scoring.
  // Derive from id as fallback: format is <providerId>:<contentHash8>
  const providerId = packed.providerId ?? packed.id.split(":")[0] ?? "unknown";
  return {
    id: packed.id,
    providerId,
    kind: packed.kind,
    scope: packed.scope,
    role: packed.role,
    content: packed.content,
    tokens: packed.tokens,
    score: packed.score,
    reason: packed.reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RawChunk enrichment
// ─────────────────────────────────────────────────────────────────────────────

/** Stamp providerId onto a raw chunk from the provider. */
function enrichRaw(chunk: RawChunk, providerId: string): RawChunk {
  return { ...chunk, providerId };
}

// ─────────────────────────────────────────────────────────────────────────────
// ContextOrchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assembles context bundles for pipeline stages.
 *
 * Usage:
 *   const orchestrator = new ContextOrchestrator(providers);
 *   const bundle = await orchestrator.assemble(request);
 */
export class ContextOrchestrator {
  constructor(private readonly providers: IContextProvider[]) {}

  /**
   * Full assembly pipeline:
   *   1. Filter providers for stage
   *   2. Parallel fetch with timeout
   *   3. Score (role × freshness × kind)
   *   4. Dedupe (trigram Jaccard ≥ 0.9)
   *   5. Role filter (drop role-mismatch chunks)
   *   6. Min-score filter (drop noise)
   *   7. Greedy pack (floor items first, budget ceiling)
   *   8. Render markdown (scope-ordered sections)
   *   9. Build digest (≤250 tokens, deterministic)
   */
  async assemble(request: ContextRequest): Promise<ContextBundle> {
    const logger = getLogger();
    const startMs = _orchestratorDeps.now();
    const requestId = _orchestratorDeps.uuid();

    const stageConfig = getStageContextConfig(request.stage);
    const role = request.role ?? stageConfig.role;
    const effectiveMinScore = request.minScore ?? MIN_SCORE;

    // Step 1: filter providers to those applicable for this stage.
    // request.providerIds (test-only override) takes precedence; otherwise stageConfig.providerIds.
    const allowedIds = request.providerIds ?? stageConfig.providerIds;
    const activeProviders = this.providers.filter((p) => allowedIds.includes(p.id));

    // Step 2: parallel fetch with timeout — failures return empty, never throw
    const fetchResults = await Promise.all(
      activeProviders.map(async (provider) => {
        try {
          return { provider, result: await fetchWithTimeout(provider, request) };
        } catch (err) {
          logger.warn("context-v2", `Provider "${provider.id}" failed — skipping`, {
            storyId: request.storyId,
            error: errorMessage(err),
          });
          return { provider, result: { chunks: [], pullTools: [] } };
        }
      }),
    );

    // Collect all raw chunks with providerIds
    const allRaw = fetchResults.flatMap(({ provider, result }) => result.chunks.map((c) => enrichRaw(c, provider.id)));
    const allPullTools = [...new Set(fetchResults.flatMap(({ result }) => result.pullTools ?? []))];

    // Step 3: score
    const scored = scoreChunks(allRaw, role, effectiveMinScore);

    // Separate role-filtered and below-min-score chunks
    const roleFiltered = scored.filter((c) => c.roleFiltered);
    const belowMin = scored.filter((c) => !c.roleFiltered && c.belowMinScore);
    const eligible = scored.filter((c) => !c.roleFiltered && !c.belowMinScore);

    // Step 4: dedupe on eligible chunks (sort by score desc first for best-representative)
    const sortedEligible = [...eligible].sort((a, b) => b.score - a.score);
    const { kept, droppedIds: dedupeDropped } = dedupeChunks(sortedEligible);

    // Step 5 & 6 already handled by scoreChunks (role filter + min score)

    // Step 7: greedy pack
    const { packed, budgetExcludedIds, usedTokens, floorItemIds } = packChunks(
      kept,
      request.budgetTokens,
      request.availableBudgetTokens,
    );

    // Step 8: render markdown
    const pushMarkdown = renderChunks(packed, {
      priorStageDigest: request.priorStageDigest,
    });

    // Step 9: build digest
    const digest = buildDigest(packed);
    const dTokens = digestTokens(digest);

    const buildMs = _orchestratorDeps.now() - startMs;

    // Build manifest
    const manifest: ContextManifest = {
      requestId,
      stage: request.stage,
      totalBudgetTokens: request.budgetTokens,
      usedTokens: usedTokens + dTokens,
      includedChunks: packed.map((c) => c.id),
      excludedChunks: [
        ...roleFiltered.map((c) => ({ id: c.id, reason: "role-filter" as const })),
        ...belowMin.map((c) => ({ id: c.id, reason: "below-min-score" as const })),
        ...dedupeDropped.map((id) => ({ id, reason: "dedupe" as const })),
        ...budgetExcludedIds.map((id) => ({ id, reason: "budget" as const })),
      ],
      floorItems: floorItemIds,
      digestTokens: dTokens,
      buildMs,
    };

    logger.debug("context-v2", "Bundle assembled", {
      storyId: request.storyId,
      stage: request.stage,
      includedChunks: packed.length,
      usedTokens: manifest.usedTokens,
      buildMs,
    });

    return {
      pushMarkdown,
      pullTools: allPullTools,
      digest,
      manifest,
      chunks: packed.map(toContextChunk),
    };
  }

  /**
   * Re-render from prior.chunks without fetching providers.
   * Used on agent availability fallback to rebuild context for a different
   * agent profile without re-running the full assembly pipeline.
   *
   * NOT a wrapper around assemble() — takes existing packed chunks and
   * re-renders only (no provider fetch, no scoring, no packing).
   */
  rebuildForAgent(prior: ContextBundle, priorStageDigest?: string): ContextBundle {
    // Re-render the same chunks with an updated digest preamble
    const packedChunks = prior.chunks.map((c) => ({
      ...c,
      // ScoredChunk fields needed by packing/render types
      rawScore: c.score,
      roleFiltered: false,
      belowMinScore: false,
    }));

    const pushMarkdown = renderChunks(packedChunks, { priorStageDigest });
    const digest = buildDigest(packedChunks);
    const dTokens = digestTokens(digest);

    const manifest: ContextManifest = {
      ...prior.manifest,
      requestId: _orchestratorDeps.uuid(),
      usedTokens: Math.max(0, prior.manifest.usedTokens - prior.manifest.digestTokens + dTokens),
      digestTokens: dTokens,
      buildMs: 0,
    };

    return {
      pushMarkdown,
      pullTools: prior.pullTools,
      digest,
      manifest,
      chunks: prior.chunks,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a default orchestrator for Phase 0/1.
 * Providers are constructed with story/config bound where needed.
 *
 * When storyScratchDirs is provided, `SessionScratchProvider` is registered
 * so the verify/rectify stages can see prior scratch observations.
 *
 * @param story           - current story (needed by FeatureContextProviderV2)
 * @param config          - nax config (needed by FeatureContextProviderV2)
 * @param storyScratchDirs - scratch dirs for this story's sessions (Phase 1+)
 */
export function createDefaultOrchestrator(
  story: UserStory,
  config: NaxConfig,
  storyScratchDirs?: string[],
): ContextOrchestrator {
  const providers: IContextProvider[] = [new StaticRulesProvider(), new FeatureContextProviderV2(story, config)];
  if (storyScratchDirs && storyScratchDirs.length > 0) {
    providers.push(new SessionScratchProvider());
  }
  // Phase 3: git history and code neighbors (always registered; active only when
  // request.touchedFiles is non-empty and the stage includes these provider IDs)
  providers.push(new GitHistoryProvider());
  providers.push(new CodeNeighborProvider());
  return new ContextOrchestrator(providers);
}
