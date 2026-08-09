/**
 * Context Engine v2 — Agent Rebuild (Phase 5.5, US-003)
 *
 * Extracted from `orchestrator.ts` so the rebuild logic lives in its own
 * file under the 600-line source limit. The public
 * `ContextOrchestrator.rebuildForAgent()` method now delegates to this
 * function via the `_orchestratorDeps.rebuild` seam.
 *
 * US-003: Re-packs chunks to fit the target profile's budget ceiling via
 * `packChunks`, reorders emitted chunks to preserve prior relative order,
 * and recomputes `floorOverageItems` from the rebuild's own pack result.
 *
 * Pure — no I/O, no logging; logging is performed via the injected
 * `deps.getLogger()` returned from `_orchestratorDeps`.
 */

import { randomUUID } from "node:crypto";
import { getLogger } from "@/logger";
import { AGENT_PROFILES, getAgentProfile } from "./agent-profiles";
import { renderForAgent } from "./agent-renderer";
import { buildDigest, digestTokens } from "./digest";
import { CHUNK_SUMMARY_CHARS } from "./manifest-builder";
import { DEFAULT_REBUILD_AGENT_ID, buildFailureNoteChunk, toContextChunk } from "./orchestrator-rebuild-helpers";
import { type PackedChunk, packChunks } from "./packing";
import { renderChunks } from "./render";
import { neutralizeForAgent } from "./scratch-neutralizer";
import type { ContextBundle, ContextChunk, ContextManifest, RebuildOptions } from "./types";

export interface RebuildDeps {
  uuid: () => string;
  getLogger: () => {
    warn(stage: string, message: string, data?: Record<string, unknown>): void;
    info(stage: string, message: string, data?: Record<string, unknown>): void;
    error(stage: string, message: string, data?: Record<string, unknown>): void;
    debug(stage: string, message: string, data?: Record<string, unknown>): void;
  };
}

const DEFAULT_REBUILD_DEPS: RebuildDeps = {
  uuid: () => randomUUID(),
  getLogger: () => getLogger(),
};

/**
 * Convert a ContextChunk back to PackedChunk shape (adds ScoredChunk fields).
 *
 * Re-applies session-scratch neutralization when swapping agents so
 * tool-name references inherited from the prior agent are normalized
 * for the target agent's conventions.
 */
function toPackedChunks(prior: ContextBundle, newAgentId: string | undefined, targetAgentId: string): PackedChunk[] {
  const priorAgentForNeutralize = prior.agentId ?? "";
  return prior.chunks.map((c) => {
    const content =
      newAgentId && newAgentId !== priorAgentForNeutralize && c.kind === "session"
        ? neutralizeForAgent(c.content, priorAgentForNeutralize, targetAgentId)
        : c.content;
    return { ...c, content, rawScore: c.score, roleFiltered: false, belowMinScore: false };
  });
}

/**
 * Re-render a prior `ContextBundle` for an optional new agent target.
 *
 * Behaviour is identical to the original `ContextOrchestrator.rebuildForAgent`
 * method. The orchestrator wrapper passes `_orchestratorDeps` so tests can
 * stub logger/uuid/clock or replace this entire function via the
 * `_orchestratorDeps.rebuild` seam.
 */
export function rebuild(
  prior: ContextBundle,
  options: RebuildOptions = {},
  deps: RebuildDeps = DEFAULT_REBUILD_DEPS,
): ContextBundle {
  const { newAgentId, failure, priorStageDigest, storyId } = options;
  const targetAgentId = newAgentId ?? prior.agentId ?? DEFAULT_REBUILD_AGENT_ID;
  const logger = deps.getLogger();

  if (newAgentId && !AGENT_PROFILES[newAgentId]) {
    logger.warn("context-v2", "rebuildForAgent: unknown agent id — using conservative defaults", {
      ...(storyId && { storyId }),
      stage: prior.manifest.stage,
      agentId: newAgentId,
    });
  }

  // Snapshot prior chunk IDs before any mutations (AC-39, M5)
  const priorChunkIds = prior.chunks.map((c) => c.id);

  const packedChunks = toPackedChunks(prior, newAgentId, targetAgentId);

  // AC-33: strip pull tools if the new agent cannot invoke tool calls.
  const targetProfile = getAgentProfile(targetAgentId).profile;
  const rebuiltPullTools = targetProfile.caps.supportsToolCalls ? prior.pullTools : [];

  // US-003: Compute the effective token ceiling for this rebuild.
  const effectiveBudget = Math.min(
    prior.manifest.effectiveBudget ?? Number.POSITIVE_INFINITY,
    targetProfile.caps.preferredPromptTokens,
  );

  // Inject failure-note chunk when this is an agent-swap rebuild.
  // Skip when the prior is already a rebuild — the prior's own failure-note
  // chunk suffices and re-injecting would double it (AC8 idempotency).
  //
  // AC7 requires the note precisely when the target ceiling is SMALLER than
  // the prior payload, so injection must not be conditioned on the payload
  // fitting — the force-include below keeps it even when packing drops it.
  let failureNoteChunk: PackedChunk | undefined;
  if (failure && newAgentId && !prior.manifest.rebuildInfo) {
    // Truthiness fallback matches the original orchestrator implementation —
    // `prior.agentId ?? ""` followed by `... || "unknown"` collapses both
    // undefined and "" to "unknown" for the failure-note chunk.
    failureNoteChunk = buildFailureNoteChunk(prior.agentId || "unknown", newAgentId, failure);
    packedChunks.push(failureNoteChunk);
  }

  // US-003: Repack chunks to fit the target ceiling. The pack budget is the
  // effective ceiling itself — packing below it would drop chunks that AC3
  // requires the rebuild to retain.
  let packResult = packChunks(packedChunks, effectiveBudget);

  // US-003 AC7: Force-include the failure-note chunk when it was excluded by packing.
  if (failureNoteChunk && !packResult.packed.some((c) => c.id === failureNoteChunk.id)) {
    packResult = {
      ...packResult,
      packed: [...packResult.packed, failureNoteChunk],
      usedTokens: packResult.usedTokens + failureNoteChunk.tokens,
    };
  }

  // US-003: Reorder selected chunks to prior order, with failure-note last.
  const chunkById = new Map<string, PackedChunk>(packResult.packed.map((c) => [c.id, c]));
  const orderedChunks: PackedChunk[] = [];
  for (const priorId of priorChunkIds) {
    const chunk = chunkById.get(priorId);
    if (chunk) orderedChunks.push(chunk);
  }
  if (failureNoteChunk && chunkById.has(failureNoteChunk.id)) {
    orderedChunks.push(failureNoteChunk);
  }

  // Re-render under the target agent's profile (or markdown-sections for same-agent rebuild)
  const pushMarkdown = newAgentId
    ? renderForAgent(orderedChunks, targetAgentId, { priorStageDigest })
    : renderChunks(orderedChunks, { priorStageDigest });

  const digest = buildDigest(orderedChunks);
  const dTokens = digestTokens(digest);

  // US-003: usedTokens from packer + digest contribution from priorStageDigest.
  const newDigestContent = priorStageDigest?.trim();
  const digestContribution = newDigestContent ? Math.ceil(newDigestContent.length / 4) : 0;
  const usedTokens = packResult.usedTokens + digestContribution;

  // US-003: chunkIdMap pairs prior chunk IDs with themselves (IDs don't change during rebuild).
  // The injected failure-note chunk is also recorded, paired with itself, so
  // downstream readers can locate the injected chunk in the rebuilt bundle via
  // the same map (US-003 AC-22 acceptance test).
  const rebuildInfo: ContextManifest["rebuildInfo"] =
    failure && newAgentId
      ? {
          priorAgentId: prior.agentId ?? "unknown",
          newAgentId: targetAgentId,
          failureCategory: failure.category,
          failureOutcome: failure.outcome,
          priorChunkIds,
          newChunkIds: orderedChunks.map((c) => c.id),
          chunkIdMap: [
            ...priorChunkIds
              .map((priorId) => {
                const entry = chunkById.get(priorId);
                return entry ? { priorChunkId: priorId, newChunkId: priorId } : null;
              })
              .filter((entry): entry is { priorChunkId: string; newChunkId: string } => entry !== null),
            ...(failureNoteChunk ? [{ priorChunkId: failureNoteChunk.id, newChunkId: failureNoteChunk.id }] : []),
          ],
        }
      : undefined;

  const includedChunkIds = new Set(orderedChunks.map((c) => c.id));
  const chunkSummaries = Object.fromEntries(orderedChunks.map((c) => [c.id, c.content.slice(0, CHUNK_SUMMARY_CHARS)]));
  const chunkEffectiveness = prior.manifest.chunkEffectiveness
    ? Object.fromEntries(Object.entries(prior.manifest.chunkEffectiveness).filter(([id]) => includedChunkIds.has(id)))
    : undefined;
  const excludedChunks = packResult.budgetExcludedIds
    .filter((id) => !includedChunkIds.has(id))
    .map((id) => ({ id, reason: "budget" as const }));

  const manifest: ContextManifest = {
    ...prior.manifest,
    requestId: deps.uuid(),
    includedChunks: orderedChunks.map((c) => c.id),
    excludedChunks,
    // Recomputed chunk tokens — a rebuild can add a chunk (the failure note)
    // that the prior map has no entry for, which would record tokens:0 (#1421).
    chunkTokens: Object.fromEntries(orderedChunks.map((c) => [c.id, c.tokens])),
    usedTokens,
    digestTokens: dTokens,
    buildMs: 0,
    rebuildInfo,
    effectiveBudget,
    // US-003 AC5: floorOverageItems from the rebuild's own pack result, not the
    // prior bundle's. The packer's `floorOverageIds` IS the set of floor chunks
    // that overflowed (cumulatively) — pass it through whole, exactly as
    // `manifest-builder.ts` does on the primary build path, so the two paths
    // report overage identically. No overflow -> undefined, likewise.
    floorItems: packResult.floorPackedIds,
    floorOverageItems: packResult.floorOverageIds.length > 0 ? packResult.floorOverageIds : undefined,
    chunkSummaries: Object.keys(chunkSummaries).length > 0 ? chunkSummaries : undefined,
    staleChunks: orderedChunks.some((c) => c.staleCandidate)
      ? orderedChunks.filter((c) => c.staleCandidate).map((c) => c.id)
      : undefined,
    chunkEffectiveness:
      chunkEffectiveness && Object.keys(chunkEffectiveness).length > 0 ? chunkEffectiveness : undefined,
  };

  const rebuiltChunks: ContextChunk[] = orderedChunks.map(toContextChunk);

  return {
    pushMarkdown,
    pullTools: rebuiltPullTools,
    digest,
    manifest,
    chunks: rebuiltChunks,
    agentId: targetAgentId,
  };
}
