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
import { PULL_TOOL_REGISTRY } from "./pull-tools";
import { SessionScratchProvider } from "./providers/session-scratch";
import { StaticRulesProvider } from "./providers/static-rules";
import { renderChunks } from "./render";
import { renderForAgent } from "./agent-renderer";
import { AGENT_PROFILES } from "./agent-profiles";
import { MIN_SCORE, scoreChunks } from "./scoring";
import { getStageContextConfig } from "./stage-config";
import type {
  AdapterFailure,
  ContextBundle,
  ContextChunk,
  ContextManifest,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
  RawChunk,
  ToolDescriptor,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Pull tool helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the ToolDescriptor list for an assemble() call.
 * Returns an empty array when pull is disabled or the stage has no pull tools.
 * Filters by pullConfig.allowedTools when non-empty (empty = allow all stage tools).
 * Overrides maxCallsPerSession from the pullConfig if it differs from the descriptor default.
 */
function buildPullToolDescriptors(
  stageToolNames: string[],
  pullConfig: ContextRequest["pullConfig"],
): ToolDescriptor[] {
  if (!pullConfig?.enabled || stageToolNames.length === 0) return [];
  const allowed = pullConfig.allowedTools;
  return stageToolNames
    .filter((name) => allowed.length === 0 || allowed.includes(name))
    .map((name) => PULL_TOOL_REGISTRY[name])
    .filter((d): d is ToolDescriptor => d !== undefined)
    .map((d) => ({ ...d, maxCallsPerSession: pullConfig.maxCallsPerSession ?? d.maxCallsPerSession }));
}

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
// Phase 5.5 — rebuild types and helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent id used when neither options.newAgentId nor prior.agentId is set.
 * Represents the historical default — change this constant (not the inline
 * fallback) if the project default agent ever changes.
 */
const DEFAULT_REBUILD_AGENT_ID = "claude";

/**
 * Options for ContextOrchestrator.rebuildForAgent().
 * All fields are optional to preserve backward-compatibility with call sites
 * that only need a digest update without an agent swap.
 *
 * Agent resolution order when newAgentId is absent:
 *   prior.agentId → DEFAULT_REBUILD_AGENT_ID ("claude")
 * This means a bundle that was assembled without an explicit agentId will be
 * re-rendered as claude/markdown-sections, which is the correct behaviour for
 * the common same-agent digest-update case. If the project default agent
 * changes, update DEFAULT_REBUILD_AGENT_ID above.
 */
export interface RebuildOptions {
  /** Target agent id for the new session (Phase 5.5 — agent-swap fallback) */
  newAgentId?: string;
  /** Adapter failure that triggered the rebuild (Phase 5.5) */
  failure?: AdapterFailure;
  /** Digest from the prior pipeline stage (optional preamble) */
  priorStageDigest?: string;
}

/**
 * Build a deterministic failure-note chunk describing the agent swap.
 * This is a synthetic chunk (no provider fetch) injected so the new agent
 * understands why the session started with pre-existing context.
 *
 * Deterministic: same inputs → byte-identical output (no LLM call).
 */
function buildFailureNoteChunk(
  priorAgentId: string,
  newAgentId: string,
  failure: AdapterFailure,
): import("./packing").PackedChunk {
  const lines = [
    "## Agent swap (availability fallback)",
    "",
    `Prior agent: ${priorAgentId} became unavailable.`,
    `Reason: ${failure.outcome} — ${failure.message}`,
    "",
    `Continuing as: ${newAgentId}`,
    "",
    "Context from the prior session has been preserved below.",
    "Resume from where the prior agent stopped.",
  ];
  const content = lines.join("\n");
  const tokens = Math.ceil(content.length / 4);
  return {
    id: `failure-note:${priorAgentId}:${newAgentId}:${failure.outcome}`,
    providerId: "orchestrator",
    kind: "session",
    scope: "session",
    role: ["all"],
    content,
    tokens,
    rawScore: 1.0,
    score: 1.0,
    roleFiltered: false,
    belowMinScore: false,
  };
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
    // Phase 4: build pull tool descriptors from stage config + PULL_TOOL_REGISTRY.
    // Provider-level result.pullTools is reserved for Phase 7 and ignored here.
    const allPullTools = buildPullToolDescriptors(
      stageConfig.pullToolNames ?? [],
      request.pullConfig,
    );

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
   *
   * Phase 5.5: accepts an optional RebuildOptions object. When options.newAgentId
   * and options.failure are provided this is an availability-fallback rebuild —
   * a failure-note chunk is injected and the push markdown is rendered under the
   * new agent's profile. When they are absent the behaviour matches the original
   * Phase 0 signature (re-render, same agent, optional digest update).
   *
   * Target latency: ≤100ms (no I/O, no provider fetching, no LLM calls).
   *
   * @param prior   - bundle from the prior assemble() or rebuildForAgent() call
   * @param options - optional: newAgentId, failure (for agent-swap), priorStageDigest
   */
  rebuildForAgent(prior: ContextBundle, options: RebuildOptions = {}): ContextBundle {
    const { newAgentId, failure, priorStageDigest } = options;
    const targetAgentId = newAgentId ?? prior.agentId ?? DEFAULT_REBUILD_AGENT_ID;
    const logger = getLogger();

    if (newAgentId && !AGENT_PROFILES[newAgentId]) {
      logger.warn("context-v2", "rebuildForAgent: unknown agent id — using conservative defaults", {
        stage: prior.manifest.stage,
        agentId: newAgentId,
      });
    }

    // Convert ContextChunks back to PackedChunk shape (adds ScoredChunk fields)
    const packedChunks: import("./packing").PackedChunk[] = prior.chunks.map((c) => ({
      ...c,
      rawScore: c.score,
      roleFiltered: false,
      belowMinScore: false,
    }));

    // Inject failure-note chunk when this is an agent-swap rebuild
    if (failure && newAgentId) {
      const priorAgentId = prior.agentId ?? "unknown";
      packedChunks.push(buildFailureNoteChunk(priorAgentId, newAgentId, failure));
    }

    // Re-render under the target agent's profile (or markdown-sections for same-agent rebuild)
    const pushMarkdown = newAgentId
      ? renderForAgent(packedChunks, targetAgentId, { priorStageDigest })
      : renderChunks(packedChunks, { priorStageDigest });

    const digest = buildDigest(packedChunks);
    const dTokens = digestTokens(digest);

    const rebuildInfo: ContextManifest["rebuildInfo"] =
      failure && newAgentId
        ? {
            priorAgentId: prior.agentId ?? "unknown",
            newAgentId: targetAgentId,
            failureCategory: failure.category,
            failureOutcome: failure.outcome,
          }
        : undefined;

    const manifest: ContextManifest = {
      ...prior.manifest,
      requestId: _orchestratorDeps.uuid(),
      usedTokens: Math.max(0, prior.manifest.usedTokens - prior.manifest.digestTokens + dTokens),
      digestTokens: dTokens,
      buildMs: 0,
      rebuildInfo,
    };

    return {
      pushMarkdown,
      pullTools: prior.pullTools,
      digest,
      manifest,
      chunks: prior.chunks,
      agentId: targetAgentId,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a default orchestrator for Phase 0–7+.
 * Providers are constructed with story/config bound where needed.
 *
 * When storyScratchDirs is provided, `SessionScratchProvider` is registered
 * so the verify/rectify stages can see prior scratch observations.
 *
 * Phase 7: accepts pre-loaded plugin providers (RAG/graph/KB) via
 * `additionalProviders`. Callers are responsible for loading these via
 * `loadPluginProviders()` before invoking this factory.
 *
 * @param story              - current story (needed by FeatureContextProviderV2)
 * @param config             - nax config (needed by FeatureContextProviderV2)
 * @param storyScratchDirs   - scratch dirs for this story's sessions (Phase 1+)
 * @param additionalProviders - pre-loaded plugin providers (Phase 7+)
 */
export function createDefaultOrchestrator(
  story: UserStory,
  config: NaxConfig,
  storyScratchDirs?: string[],
  additionalProviders: IContextProvider[] = [],
): ContextOrchestrator {
  const allowLegacyClaudeMd = config.context?.v2?.rules?.allowLegacyClaudeMd ?? true;
  const providers: IContextProvider[] = [
    new StaticRulesProvider({ allowLegacyClaudeMd }),
    new FeatureContextProviderV2(story, config),
  ];
  if (storyScratchDirs && storyScratchDirs.length > 0) {
    providers.push(new SessionScratchProvider());
  }
  // Phase 3: git history and code neighbors (always registered; active only when
  // request.touchedFiles is non-empty and the stage includes these provider IDs)
  providers.push(new GitHistoryProvider());
  providers.push(new CodeNeighborProvider());
  // Phase 7: plugin providers (RAG, graph, KB, etc.)
  providers.push(...additionalProviders);
  return new ContextOrchestrator(providers);
}
