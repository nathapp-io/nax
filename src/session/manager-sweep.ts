/**
 * sweepOrphansImpl — orphan session sweep extracted from SessionManager.
 *
 * Extracted from manager.ts to give manager.ts comfortable headroom below the
 * 600-line project limit. Receives the sessions map directly to avoid coupling
 * to the full SessionManager class.
 */

import { getLogger } from "../logger";
import { _sessionManagerDeps } from "./manager-deps";
import type { SessionDescriptor, SessionState } from "./types";

/** Default TTL for orphan sweep: 4 hours */
export const DEFAULT_ORPHAN_TTL_MS = 4 * 60 * 60 * 1000;

export function sweepOrphansImpl(sessions: Map<string, SessionDescriptor>, ttlMs: number): number {
  const cutoff = _sessionManagerDeps.nowMs() - ttlMs;
  const terminal: SessionState[] = ["COMPLETED", "FAILED"];
  let removed = 0;

  for (const [id, session] of sessions.entries()) {
    if (!terminal.includes(session.state)) continue;
    if (new Date(session.lastActivityAt).getTime() < cutoff) {
      sessions.delete(id);
      removed++;
    }
  }

  if (removed > 0) {
    getLogger().debug("session", "Swept orphan sessions", { removed });
  }

  return removed;
}
