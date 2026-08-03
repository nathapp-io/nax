/**
 * Phase 5.5 rebuild helpers for ContextOrchestrator.
 *
 * Extracted from orchestrator.ts to keep that file under the 600-line limit.
 * Pure — no I/O, no logging. Deterministic: same inputs → byte-identical output.
 */

import type { PackedChunk } from "./packing";
import type { AdapterFailure } from "./types";

/**
 * Agent id used when neither options.newAgentId nor prior.agentId is set.
 * Represents the historical default — change this constant (not the inline
 * fallback) if the project default agent ever changes.
 */
export const DEFAULT_REBUILD_AGENT_ID = "claude";

/**
 * Build a deterministic failure-note chunk describing the agent swap.
 * This is a synthetic chunk (no provider fetch) injected so the new agent
 * understands why the session started with pre-existing context.
 *
 * Deterministic: same inputs → byte-identical output (no LLM call).
 */
export function buildFailureNoteChunk(priorAgentId: string, newAgentId: string, failure: AdapterFailure): PackedChunk {
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
