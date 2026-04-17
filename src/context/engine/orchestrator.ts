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
import { getLogger } from "../../logger";
import { errorMessage } from "../../utils/errors";
import { AGENT_PROFILES, getAgentProfile } from "./agent-profiles";
import { renderForAgent } from "./agent-renderer";
import { dedupeChunks } from "./dedupe";
import { buildDigest, digestTokens } from "./digest";
import { packChunks } from "./packing";
import type { PackedChunk } from "./packing";
import { PULL_TOOL_REGISTRY } from "./pull-tools";
import { renderChunks } from "./render";
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
  RebuildOptions,
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

    // Resolve agent profile (AC-32, AC-33). Unknown agents fall back to the
    // conservative default; a warning is logged so operators can see why
    // the bundle was sized for the safe profile.
    const agentId = request.agentId ?? "claude";
    const { profile: agentProfile, isDefault: agentProfileIsDefault } = getAgentProfile(agentId);
    if (agentProfileIsDefault) {
      logger.warn("context-v2", "Unknown agent id — using CONSERVATIVE_DEFAULT_PROFILE", {
        storyId: request.storyId,
        stage: request.stage,
        agentId,
      });
    }

    // AC-32: agent profile tightens the budget ceiling. Effective budget is
    // min(stage budget, agent preferred prompt tokens, caller availableBudget).
    const profileBudget = agentProfile.caps.preferredPromptTokens;
    const effectiveBudgetTokens = Math.min(request.budgetTokens, profileBudget);

    // Step 1: filter providers to those applicable for this stage.
    // request.providerIds (test-only override) takes precedence; otherwise stageConfig.providerIds.
    const allowedIds = request.providerIds ?? stageConfig.providerIds;
    const activeProviders = this.providers.filter((p) => allowedIds.includes(p.id));

    // Step 2: parallel fetch with timeout — failures return empty, never throw.
    // Per-provider status is recorded for manifest auditability (Finding 3).
    const fetchResults = await Promise.all(
      activeProviders.map(async (provider) => {
        const providerStart = _orchestratorDeps.now();
        try {
          const result = await fetchWithTimeout(provider, request);
          const durationMs = _orchestratorDeps.now() - providerStart;
          const status = result.chunks.length === 0 ? ("empty" as const) : ("ok" as const);
          return {
            provider,
            result,
            providerStatus: { providerId: provider.id, status, chunkCount: result.chunks.length, durationMs },
          };
        } catch (err) {
          const durationMs = _orchestratorDeps.now() - providerStart;
          const errMsg = errorMessage(err);
          const status = errMsg.includes("timed out") ? ("timeout" as const) : ("failed" as const);
          logger.warn("context-v2", `Provider "${provider.id}" ${status} — skipping`, {
            storyId: request.storyId,
            error: errMsg,
          });
          return {
            provider,
            result: { chunks: [], pullTools: [] },
            providerStatus: { providerId: provider.id, status, chunkCount: 0, durationMs, error: errMsg },
          };
        }
      }),
    );

    // Collect all raw chunks with providerIds
    const allRaw = fetchResults.flatMap(({ provider, result }) => result.chunks.map((c) => enrichRaw(c, provider.id)));
    const providerResults = fetchResults.map(({ providerStatus }) => providerStatus);
    // Phase 4: build pull tool descriptors from stage config + PULL_TOOL_REGISTRY.
    // Provider-level result.pullTools is reserved for Phase 7 and ignored here.
    // AC-33: gate pull tools on agent capability. When the agent cannot invoke
    // tool calls, we must not surface any — the adapter cannot register them.
    const allPullTools = agentProfile.caps.supportsToolCalls
      ? buildPullToolDescriptors(stageConfig.pullToolNames ?? [], request.pullConfig)
      : [];

    // Step 3: score (role × freshness × kind). Role-mismatch sets roleFiltered
    // but the chunk still enters dedupe so audience unions can promote it.
    const scored = scoreChunks(allRaw, role, effectiveMinScore);

    // Step 4: dedupe ALL scored chunks (AC-9). The dedupe pass unions audience
    // tags onto the kept representative; role filtering runs on the unioned
    // roles in step 5.
    const sortedAll = [...scored].sort((a, b) => b.score - a.score);
    const { kept: dedupedKept, droppedIds: dedupeDropped } = dedupeChunks(sortedAll);

    // Step 5: role filter post-dedupe. Recompute roleFiltered using the unioned
    // roles so a chunk whose dropped duplicate was role-matched is retained.
    const postRoleFilter = dedupedKept.map((c) => {
      const matches = c.role.includes(role) || c.role.includes("all");
      return matches ? { ...c, roleFiltered: false } : { ...c, roleFiltered: true };
    });
    const roleFiltered = postRoleFilter.filter((c) => c.roleFiltered);

    // Step 6: min-score filter (already marked in step 3; still applies after dedupe).
    const belowMin = postRoleFilter.filter((c) => !c.roleFiltered && c.belowMinScore);
    const kept = postRoleFilter.filter((c) => !c.roleFiltered && !c.belowMinScore);

    // Step 7: greedy pack. Apply agent-profile ceiling to the stage budget so
    // the final budget is min(stage, profile, caller availableBudget).
    const { packed, budgetExcludedIds, usedTokens, floorPackedIds, floorOverageIds } = packChunks(
      kept,
      effectiveBudgetTokens,
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
      floorItems: floorPackedIds,
      floorOverageItems: floorOverageIds.length > 0 ? floorOverageIds : undefined,
      digestTokens: dTokens,
      buildMs,
      providerResults,
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
      // Propagate agentId when the caller specifies a target agent (Phase 7+).
      ...(request.agentId !== undefined && { agentId: request.agentId }),
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
   * Wired into the execution stage via rebuildForSwap() (Issue #474).
   *
   * Target latency: ≤100ms (no I/O, no provider fetching, no LLM calls).
   *
   * @param prior   - bundle from the prior assemble() or rebuildForAgent() call
   * @param options - optional: newAgentId, failure (for agent-swap), priorStageDigest
   */
  rebuildForAgent(prior: ContextBundle, options: RebuildOptions = {}): ContextBundle {
    const { newAgentId, failure, priorStageDigest, storyId } = options;
    const targetAgentId = newAgentId ?? prior.agentId ?? DEFAULT_REBUILD_AGENT_ID;
    const logger = getLogger();

    if (newAgentId && !AGENT_PROFILES[newAgentId]) {
      logger.warn("context-v2", "rebuildForAgent: unknown agent id — using conservative defaults", {
        ...(storyId && { storyId }),
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

    // Recompute token delta: failure-note chunk adds tokens not present in prior bundle.
    const extraTokens = packedChunks
      .filter((c) => !prior.chunks.some((pc) => pc.id === c.id))
      .reduce((sum, c) => sum + c.tokens, 0);

    const manifest: ContextManifest = {
      ...prior.manifest,
      requestId: _orchestratorDeps.uuid(),
      // Update includedChunks so the manifest reflects the actual rendered content.
      includedChunks: packedChunks.map((c) => c.id),
      usedTokens: Math.max(0, prior.manifest.usedTokens - prior.manifest.digestTokens + dTokens + extraTokens),
      digestTokens: dTokens,
      buildMs: 0,
      rebuildInfo,
    };

    // AC-33: strip pull tools if the new agent cannot invoke tool calls.
    const targetProfile = getAgentProfile(targetAgentId).profile;
    const rebuiltPullTools = targetProfile.caps.supportsToolCalls ? prior.pullTools : [];

    return {
      pushMarkdown,
      pullTools: rebuiltPullTools,
      digest,
      manifest,
      // Return the full packedChunks (including any injected failure-note) so
      // bundle.chunks matches what was actually rendered into pushMarkdown.
      chunks: packedChunks.map(toContextChunk),
      agentId: targetAgentId,
    };
  }
}
