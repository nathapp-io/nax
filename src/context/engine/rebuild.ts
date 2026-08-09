/**
 * Context Engine v2 — Agent Rebuild (Phase 5.5)
 *
 * Extracted from `orchestrator.ts` so the rebuild logic lives in its own
 * file under the 600-line source limit. The public
 * `ContextOrchestrator.rebuildForAgent()` method now delegates to this
 * function via the `_orchestratorDeps.rebuild` seam.
 *
 * Behaviour is unchanged from the original `rebuildForAgent` method.
 *
 * Pure — no I/O, no logging; logging is performed via the injected
 * `deps.getLogger()` returned from `_orchestratorDeps`.
 */

import { randomUUID } from "node:crypto";
import { getLogger } from "@/logger";
import { AGENT_PROFILES, getAgentProfile } from "./agent-profiles";
import { renderForAgent } from "./agent-renderer";
import { buildDigest, digestTokens } from "./digest";
import { rebuildUsedTokens } from "./manifest-builder";
import { DEFAULT_REBUILD_AGENT_ID, buildFailureNoteChunk } from "./orchestrator-rebuild-helpers";
import type { PackedChunk } from "./packing";
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

  // Inject failure-note chunk when this is an agent-swap rebuild
  if (failure && newAgentId) {
    packedChunks.push(buildFailureNoteChunk(prior.agentId ?? "unknown", newAgentId, failure));
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
          priorChunkIds,
          newChunkIds: packedChunks.map((c) => c.id),
          chunkIdMap: priorChunkIds
            .map((priorChunkId, index) => {
              const newChunkId = packedChunks[index]?.id;
              return newChunkId ? { priorChunkId, newChunkId } : null;
            })
            .filter((entry): entry is { priorChunkId: string; newChunkId: string } => entry !== null),
        }
      : undefined;

  const usedTokens = rebuildUsedTokens(prior, packedChunks, priorStageDigest);

  // AC-33: strip pull tools if the new agent cannot invoke tool calls.
  const targetProfile = getAgentProfile(targetAgentId).profile;
  const rebuiltPullTools = targetProfile.caps.supportsToolCalls ? prior.pullTools : [];

  const manifest: ContextManifest = {
    ...prior.manifest,
    requestId: deps.uuid(),
    includedChunks: packedChunks.map((c) => c.id),
    // Recomputed chunk tokens — a rebuild can add a chunk (the failure note)
    // that the prior map has no entry for, which would record tokens:0 (#1421).
    chunkTokens: Object.fromEntries(packedChunks.map((c) => [c.id, c.tokens])),
    usedTokens,
    digestTokens: dTokens,
    buildMs: 0,
    rebuildInfo,
    // Re-tighten to the target agent's own ceiling on an agent swap — the spread above
    // otherwise carries the PRIOR agent's effectiveBudget forward alongside the new
    // agent's content (and any injected failure-note chunk), which would make
    // computeFloorOverage (src/metrics/tracker.ts) compute overage against the wrong
    // ceiling for every swapped story.
    effectiveBudget: Math.min(
      prior.manifest.effectiveBudget ?? Number.POSITIVE_INFINITY,
      targetProfile.caps.preferredPromptTokens,
    ),
  };

  const rebuiltChunks: ContextChunk[] = packedChunks.map((c) => {
    // providerId is set by enrichRaw() in the orchestrator before scoring.
    // Derive from id as fallback: format is <providerId>:<contentHash8>
    const providerId = c.providerId ?? c.id.split(":")[0] ?? "unknown";
    return {
      id: c.id,
      providerId,
      kind: c.kind,
      scope: c.scope,
      role: c.role,
      content: c.content,
      tokens: c.tokens,
      rawScore: c.rawScore,
      score: c.score,
      reason: c.reason,
      ...(c.staleCandidate && { staleCandidate: true }),
    };
  });

  return {
    pushMarkdown,
    pullTools: rebuiltPullTools,
    digest,
    manifest,
    // Return the full packedChunks (including any injected failure-note) so
    // bundle.chunks matches what was actually rendered into pushMarkdown.
    chunks: rebuiltChunks,
    agentId: targetAgentId,
  };
}
