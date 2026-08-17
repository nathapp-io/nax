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
  let removed = 0;

  for (const [id, session] of sessions.entries()) {
    // A missing or unparseable lastActivityAt yields NaN, and `NaN < cutoff` is
    // always false — a session with no usable timestamp has no defensible
    // retention window, so treat it as expired rather than leaking the map
    // entry forever. (MEM-1: this applies to terminal AND non-terminal
    // sessions — pre-fix the function skipped non-terminal entries entirely,
    // so a session stuck RUNNING after a crash was never evicted.)
    const lastActivityMs = session.lastActivityAt ? new Date(session.lastActivityAt).getTime() : Number.NaN;
    if (Number.isFinite(lastActivityMs) && lastActivityMs >= cutoff) continue;
    sessions.delete(id);
    removed++;
  }

  if (removed > 0) {
    getLogger().debug("session", "Swept orphan sessions", { removed });
  }

  return removed;
}
