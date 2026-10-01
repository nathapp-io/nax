/**
 * Record an agent swap on the session descriptor it actually happened to.
 *
 * nax#1722: `SessionManager.handoff()` is what keeps a descriptor's `agent` field
 * truthful across a swap, but its only caller guarded on a `sessionId` that `callOp`
 * never carries (`src/operations/call.ts` passes `undefined` — ops don't own
 * pipeline-level session descriptors). Nothing else updates the field either:
 * `openSession` re-opens the same session name under the fallback agent and every
 * branch of its descriptor reconciliation leaves `agent` at the primary. So once
 * swaps started firing, every artifact read off that descriptor misattributed the
 * fallback agent's work to the agent that had already failed.
 *
 * Both hop paths that can change agent mid-session — `buildHopCallback` (callOp) and
 * `createSessionRunHop` (the manager's internal runHop) — call this after the session
 * for the new agent is open. Keyed by session NAME, which is what a hop knows.
 */

import type { ISessionManager } from "./types";

/**
 * No-op unless a descriptor exists under `sessionName` and names a different agent,
 * so callers may call it on every hop without checking the hop kind first.
 */
export function recordAgentHandoff(
  sessionManager: Pick<ISessionManager, "descriptor" | "handoff">,
  sessionName: string,
  newAgent: string,
  reason?: string,
): void {
  const descriptor = sessionManager.descriptor(sessionName);
  if (!descriptor || descriptor.agent === newAgent) return;
  sessionManager.handoff?.(descriptor.id, newAgent, reason);
}
