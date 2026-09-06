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

import { createHash, randomUUID } from "node:crypto";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import { NeutralityLintError } from "../rules/canonical-loader";
import { getAgentProfile } from "./agent-profiles";
import { renderForAgent } from "./agent-renderer";
import { dedupeChunks } from "./dedupe";
import { buildDigest, DIGEST_RESERVE_TOKENS, digestTokens } from "./digest";
import { buildManifest } from "./manifest-builder";
import { toContextChunk } from "./orchestrator-rebuild-helpers";
import { FLOOR_KINDS, packChunks } from "./packing";
import { DEFAULT_MAX_CALLS_PER_SESSION, PULL_TOOL_REGISTRY } from "./pull-tools";
import { type RebuildDeps, rebuild } from "./rebuild";
import { FIXED_RENDER_OVERHEAD_TOKENS, renderChunks, separatorOverheadTokens } from "./render";
import { MIN_SCORE, scoreChunks } from "./scoring";
import { getStageContextConfig } from "./stage-config";
import type {
  ContextBundle,
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
 *
 * `maxCallsPerSession` precedence: an operator-configured ceiling wins; otherwise
 * each descriptor keeps its own per-tool value. Because the config schema defaults
 * this key, `pullConfig.maxCallsPerSession` is never undefined — a plain `??` here
 * meant the config value always won and a descriptor could never carry a ceiling
 * of its own. Treating "equal to the shared default" as "not configured" restores
 * the documented behaviour; it is only ambiguous for an operator who explicitly
 * sets the default value, which by definition changes nothing.
 */
function buildPullToolDescriptors(
  stageToolNames: string[],
  pullConfig: ContextRequest["pullConfig"],
): ToolDescriptor[] {
  if (!pullConfig?.enabled || stageToolNames.length === 0) return [];
  const allowed = pullConfig.allowedTools;
  const configured = pullConfig.maxCallsPerSession;
  const override = configured !== undefined && configured !== DEFAULT_MAX_CALLS_PER_SESSION ? configured : undefined;
  return stageToolNames
    .filter((name) => allowed.length === 0 || allowed.includes(name))
    .map((name) => PULL_TOOL_REGISTRY[name])
    .filter((d): d is ToolDescriptor => d !== undefined)
    .map((d) => ({ ...d, maxCallsPerSession: override ?? d.maxCallsPerSession }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _orchestratorDeps = {
  now: () => Date.now(),
  uuid: () => randomUUID(),
  getLogger,
  rebuild: rebuild as (prior: ContextBundle, options?: RebuildOptions, deps?: RebuildDeps) => ContextBundle,
};

type ProviderActivationSource = NonNullable<NonNullable<ContextManifest["providerResults"]>[number]["source"]>;

// ─────────────────────────────────────────────────────────────────────────────
// Provider fetch timeout
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_FETCH_TIMEOUT_MS = 5_000;

/** #1776: cap on how many floor items the budget-exceeded warn enumerates. */
const FLOOR_OVERAGE_LOG_LIMIT = 10;

export async function fetchWithTimeout(
  provider: IContextProvider,
  request: ContextRequest,
  timeoutMs = PROVIDER_FETCH_TIMEOUT_MS,
): Promise<ContextProviderResult> {
  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeout = new Promise<ContextProviderResult>((_, reject) => {
    handle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`Provider "${provider.id}" timed out`));
    }, timeoutMs);
  });

  // Wrap the fetch so that if the abort fires synchronously inside abort(),
  // we map it to a "timed out" rejection rather than letting the raw "aborted"
  // error win the race against the timeout rejection.
  const fetchPromise = provider.fetch(request, controller.signal).then(
    (result) => result,
    (err) => {
      if (timedOut) {
        // @design Never-settling so the timeout rejection wins; do not retain the race result.
        return new Promise<ContextProviderResult>(() => {});
      }
      throw err;
    },
  );

  try {
    return await Promise.race([fetchPromise, timeout]);
  } finally {
    clearTimeout(handle);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RawChunk enrichment
// ─────────────────────────────────────────────────────────────────────────────

/** Stamp providerId onto a raw chunk from the provider. */
function enrichRaw(chunk: RawChunk, providerId: string): RawChunk {
  return { ...chunk, providerId };
}

function buildProviderSourceMap(
  stageProviderIds: string[],
  extraProviderIds: string[],
): Map<string, ProviderActivationSource> {
  const sourceMap = new Map<string, ProviderActivationSource>();
  for (const id of stageProviderIds) sourceMap.set(id, "stage-config");
  for (const id of extraProviderIds) {
    if (!sourceMap.has(id)) sourceMap.set(id, "extra");
  }
  return sourceMap;
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
    const logger = _orchestratorDeps.getLogger();
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

    // AC-32 + US-001: reserve digest + prior digest + fixed framing; per-chunk separator from kept below.
    // availableBudgetTokens (the caller's remaining-window ceiling) is folded in here, before the
    // reserve subtractions, so a binding remaining-window value cannot bypass the reserves — it must
    // shrink alongside budgetTokens/profileBudget, not compete with the already-reserved result.
    const profileBudget = agentProfile.caps.preferredPromptTokens;
    const stageCeiling = Math.min(
      request.budgetTokens,
      profileBudget,
      request.availableBudgetTokens ?? Number.POSITIVE_INFINITY,
    );
    const trimmedPriorDigest = request.priorStageDigest?.trim();
    const priorDigestTokens = trimmedPriorDigest ? Math.ceil(trimmedPriorDigest.length / 4) : 0;
    let effectiveBudgetTokens = Math.max(
      0,
      stageCeiling - DIGEST_RESERVE_TOKENS - priorDigestTokens - FIXED_RENDER_OVERHEAD_TOKENS,
    );

    // Step 1: filter providers to those applicable for this stage.
    // request.providerIds (test-only override) takes precedence; otherwise stageConfig.providerIds.
    const providerSourceMap =
      request.providerIds === undefined
        ? buildProviderSourceMap(stageConfig.providerIds, request.extraProviderIds ?? [])
        : new Map<string, ProviderActivationSource>();
    const allowedIds = request.providerIds ?? [...providerSourceMap.keys()];
    const allowedIdSet = new Set(allowedIds);
    // AC-24: determinism mode — skip providers that declare deterministic: false.
    const activeProviders = this.providers.filter(
      (p) => allowedIdSet.has(p.id) && !(request.deterministic === true && p.deterministic === false),
    );

    // AC-16: detect providerIds configured by the user that matched no registered provider.
    // The check is scoped to config-derived IDs (stageConfig.providerIds) — request.providerIds
    // is a test-only override and is intentionally permitted to reference unregistered IDs so
    // tests can assert "unknown ID filters to empty" semantics without registering stubs.
    if (request.providerIds === undefined) {
      const registeredIds = new Set(this.providers.map((p) => p.id));
      const unknownProviderIds = [...providerSourceMap.keys()].filter((id) => !registeredIds.has(id));
      if (unknownProviderIds.length > 0) {
        logger.error("context-v2", "Unknown provider IDs in stage config", {
          storyId: request.storyId,
          stage: request.stage,
          unknownProviderIds,
          extraProviderIds: request.extraProviderIds ?? [],
          availableProviderIds: [...registeredIds].sort(),
        });
        throw new NaxError(
          `Unknown context provider ID(s): ${unknownProviderIds.join(", ")}. Available providers: ${[...registeredIds].sort().join(", ")}`,
          "CONTEXT_UNKNOWN_PROVIDER_IDS",
          {
            stage: "context-v2",
            storyId: request.storyId,
            requestStage: request.stage,
            unknownProviderIds,
          },
        );
      }
    }

    // Step 2: parallel fetch with timeout — failures return empty, never throw,
    // except a NeutralityLintError, which escalates (see catch below). Per-
    // provider status is recorded for manifest auditability (Finding 3).
    const fetchResults = await Promise.all(
      activeProviders.map(async (provider) => {
        const providerStart = _orchestratorDeps.now();
        try {
          const result = await fetchWithTimeout(provider, request, request.providerTimeoutMs);
          const durationMs = _orchestratorDeps.now() - providerStart;
          const status = result.chunks.length === 0 ? ("empty" as const) : ("ok" as const);
          const tokensProduced = result.chunks.reduce((sum, c) => sum + c.tokens, 0);
          const rawCostUsd = result.chunks.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
          return {
            provider,
            result,
            providerStatus: {
              providerId: provider.id,
              status,
              source: providerSourceMap.get(provider.id),
              chunkCount: result.chunks.length,
              durationMs,
              tokensProduced,
              ...(rawCostUsd > 0 && { costUsd: rawCostUsd }),
              ...(result.budgetPressure && { budgetPressure: result.budgetPressure }),
              ...(result.scopingReport && { scopingReport: result.scopingReport }),
            },
          };
        } catch (err) {
          const durationMs = _orchestratorDeps.now() - providerStart;
          const errMsg = errorMessage(err);
          const status = errMsg.includes("timed out") ? ("timeout" as const) : ("failed" as const);

          // Escalate on THIS error type only (see IContextProvider.fetch in
          // types.ts) — not `provider.kind === "static"` generally, since a
          // static provider timeout/IO error should still soft-skip.
          if (err instanceof NeutralityLintError) {
            const msg = `Rules provider "${provider.id}" failed neutrality lint — escalating`;
            logger.error("context-v2", msg, { storyId: request.storyId, error: errMsg });
            throw err;
          }

          logger.warn("context-v2", `Provider "${provider.id}" ${status} — skipping`, {
            storyId: request.storyId,
            error: errMsg,
          });
          return {
            provider,
            result: { chunks: [], pullTools: [] },
            providerStatus: {
              providerId: provider.id,
              status,
              source: providerSourceMap.get(provider.id),
              chunkCount: 0,
              durationMs,
              tokensProduced: 0,
              error: errMsg,
            },
          };
        }
      }),
    );

    // Collect all raw chunks with providerIds
    const allRaw = fetchResults.flatMap(({ provider, result }) => result.chunks.map((c) => enrichRaw(c, provider.id)));
    const providerResults = fetchResults.map(({ providerStatus }) => providerStatus);

    // Amendment B AC-51: inject plan digest as a boosted RawChunk when planDigestBoost > 1.
    // This replaces raw "## Prior Stage Summary" markdown rendering for single-session modes,
    // making the digest compete in scoring/packing and appear in manifest.includedChunks.
    if (request.priorStageDigest && (request.planDigestBoost ?? 1.0) > 1.0) {
      const boost = request.planDigestBoost ?? 1.0;
      const hash = createHash("sha256").update(request.priorStageDigest).digest("hex").slice(0, 8);
      const tokens = Math.ceil(request.priorStageDigest.length / 4);
      allRaw.push({
        id: `plan-digest:${hash}`,
        providerId: "plan-digest",
        kind: "session",
        scope: "session",
        role: ["all"],
        content: request.priorStageDigest,
        tokens,
        rawScore: 0.9 * boost,
      });
      providerResults.push({
        providerId: "plan-digest",
        status: "ok",
        source: undefined,
        chunkCount: 1,
        durationMs: 0,
        tokensProduced: tokens,
      });
    }

    // Phase 4: build pull tool descriptors from stage config + PULL_TOOL_REGISTRY.
    // Provider-level result.pullTools is reserved for Phase 7 and ignored here.
    // AC-33: gate pull tools on agent capability. When the agent cannot invoke
    // tool calls, we must not surface any — the adapter cannot register them.
    const allPullTools = agentProfile.caps.supportsToolCalls
      ? buildPullToolDescriptors(stageConfig.pullToolNames ?? [], request.pullConfig)
      : [];

    // Step 3: score (role × freshness × kind × effectiveness). Role-mismatch sets roleFiltered
    // but the chunk still enters dedupe so audience unions can promote it.
    // US-004: providerWeights threaded from request — scoreChunk multiplies by
    // the keyed weight on chunk.providerId (identity when omitted).
    const scored = scoreChunks(allRaw, role, effectiveMinScore, request.providerWeights);

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
    // Floor kinds (static, feature, test-coverage) bypass the filter regardless of score.
    const belowMin = postRoleFilter.filter((c) => !c.roleFiltered && c.belowMinScore && !FLOOR_KINDS.includes(c.kind));
    const kept = postRoleFilter.filter((c) => !c.roleFiltered && (!c.belowMinScore || FLOOR_KINDS.includes(c.kind)));

    effectiveBudgetTokens = Math.max(0, effectiveBudgetTokens - separatorOverheadTokens(kept));
    // Step 7: greedy pack. availableBudgetTokens is already folded into effectiveBudgetTokens
    // above (before the reserve subtractions), so no third ceiling argument is passed here —
    // passing it separately would let it bypass the reserves via packChunks' own Math.min.
    const { packed, budgetExcludedIds, usedTokens, floorPackedIds, floorOverageIds, effectiveBudget } = packChunks(
      kept,
      effectiveBudgetTokens,
    );

    // US-003 AC-4: surface floor overage observability. Floor-kind chunks still
    // pack even when they overflow the effective budget; this warn makes the
    // overage visible without changing which chunks are included. The
    // `effectiveBudget` value reported here is the post-`availableBudgetTokens`
    // ceiling packChunks actually used — never the pre-ceiling request budget.
    if (floorOverageIds.length > 0) {
      logger.warnOnce("context-v2", "Floor-budget overage — floor chunks pushed bundle past effective budget", {
        storyId: request.storyId,
        stage: request.stage,
        effectiveBudget,
        excludedNonFloorChunkCount: budgetExcludedIds.length,
      });
    }

    // Step 8: render for the requested agent, preserving legacy markdown when absent.
    const renderOptions = { priorStageDigest: request.priorStageDigest };
    const pushMarkdown =
      request.agentId !== undefined
        ? renderForAgent(packed, request.agentId, renderOptions)
        : renderChunks(packed, renderOptions);

    // Step 9: build digest
    const digest = buildDigest(packed);
    const dTokens = digestTokens(digest);

    const buildMs = _orchestratorDeps.now() - startMs;

    const manifest = buildManifest({
      requestId,
      request,
      packed,
      usedTokens,
      digestTokens: dTokens,
      buildMs,
      providerResults,
      roleFiltered,
      belowMin,
      dedupeDropped,
      budgetExcludedIds,
      floorPackedIds,
      floorOverageIds,
      effectiveBudget,
    });

    // #1776: floor items (static rules, feature/test-coverage floor chunks)
    // bypass packing's budget check entirely, so `usedTokens` can silently
    // land 2-3x over `totalBudgetTokens` with nothing surfacing it beyond a
    // manifest field nobody reads at runtime. Name the floor items and their
    // token cost so this is visible without a manifest diff.
    if (manifest.usedTokens > manifest.totalBudgetTokens) {
      const overageIds = manifest.floorOverageItems ?? manifest.floorItems;
      // This condition holds on nearly every stage of every story, and the
      // floor routinely runs to 60+ chunks — log the heaviest few plus a
      // count rather than the whole list, so the warn stays readable.
      const byCost = overageIds
        .map((id) => ({ id, tokens: manifest.chunkTokens?.[id] ?? 0 }))
        .sort((a, b) => b.tokens - a.tokens || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      logger.warnOnce("context-v2", "Stage budget exceeded by floor items", {
        storyId: request.storyId,
        stage: request.stage,
        usedTokens: manifest.usedTokens,
        totalBudgetTokens: manifest.totalBudgetTokens,
        floorOverageCount: byCost.length,
        heaviestFloorItems: byCost.slice(0, FLOOR_OVERAGE_LOG_LIMIT),
      });
    }

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
      // Propagate featureId so pull-tool handlers can rebuild an equivalent
      // request (fragment reads early-return without it).
      ...(request.featureId !== undefined && { featureId: request.featureId }),
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
    return _orchestratorDeps.rebuild(prior, options, {
      uuid: _orchestratorDeps.uuid,
      getLogger: _orchestratorDeps.getLogger,
    });
  }
}
