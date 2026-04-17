/**
 * Agent-swap escalation — Phase 5.5 (Issue #474)
 *
 * Pure logic for resolving the next agent candidate and rebuilding the context
 * bundle after an availability failure. No I/O — callers (execution stage) own
 * the retry loop and state mutations.
 */

import type { ContextV2FallbackConfig } from "../../config/runtime-types";
import { ContextOrchestrator } from "../../context/engine";
import type { AdapterFailure, ContextBundle } from "../../context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Swappable deps (for testing without mock.module())
// ─────────────────────────────────────────────────────────────────────────────

export const _agentSwapDeps = {
  rebuildForAgent: (prior: ContextBundle, opts: { newAgentId?: string; failure?: AdapterFailure }): ContextBundle =>
    new ContextOrchestrator([]).rebuildForAgent(prior, opts),
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the next agent id to try from the fallback map.
 *
 * `swapCount` is the number of swaps already completed (0 = first swap).
 * The candidates array is indexed by swapCount so each hop picks the next
 * agent in the configured order.
 *
 * Returns null when no candidate is available at the current hop.
 */
export function resolveSwapTarget(
  currentAgentId: string,
  fallbackMap: Record<string, string[]>,
  swapCount: number,
): string | null {
  const candidates = fallbackMap[currentAgentId];
  if (!candidates || candidates.length === 0) return null;
  return candidates[swapCount] ?? null;
}

/**
 * Determine whether an agent-swap should be attempted for this failure.
 *
 * Conditions:
 * - Config enabled
 * - A context bundle exists (nothing to rebuild otherwise)
 * - Under the per-story hop cap
 * - Failure category is "availability" (or "quality" when onQualityFailure is set)
 */
export function shouldAttemptSwap(
  failure: AdapterFailure | undefined,
  fallbackConfig: ContextV2FallbackConfig,
  swapCount: number,
  currentBundle: ContextBundle | undefined,
): boolean {
  if (!failure) return false;
  if (!fallbackConfig.enabled) return false;
  if (!currentBundle) return false;
  if (swapCount >= fallbackConfig.maxHopsPerStory) return false;
  if (failure.category === "availability") return true;
  return fallbackConfig.onQualityFailure;
}

/**
 * Rebuild the context bundle for a new agent after an availability failure.
 *
 * Delegates to ContextOrchestrator.rebuildForAgent() which:
 * - Re-renders prior.chunks without fetching providers (≤100ms)
 * - Injects a failure-note chunk so the new agent sees why it took over
 * - Stamps manifest.rebuildInfo with priorAgentId/newAgentId/failure
 * - Strips pull tools when the new agent's profile lacks supportsToolCalls
 */
export function rebuildForSwap(prior: ContextBundle, newAgentId: string, failure: AdapterFailure): ContextBundle {
  return _agentSwapDeps.rebuildForAgent(prior, { newAgentId, failure });
}
