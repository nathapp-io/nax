/**
 * SessionManager — centralized session lifecycle for nax agent sessions.
 *
 * Phase 0: skeleton with create/get/transition. Runs in dual-write mode
 * alongside the legacy ACP adapter sidecar — the manager is NOT yet
 * authoritative for session naming or physical session lifecycle.
 *
 * Phase 5.5: manager becomes sole owner; adapter sidecar and legacy
 * fallback walk are removed (~315 lines deleted from adapter.ts).
 *
 * See: docs/specs/SPEC-session-manager-integration.md
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import type {
  CreateSessionOptions,
  ISessionManager,
  ProtocolIds,
  SessionDescriptor,
  SessionState,
  TransitionOptions,
} from "./types";
import { SESSION_TRANSITIONS } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default TTL for orphan sweep: 4 hours */
const DEFAULT_ORPHAN_TTL_MS = 4 * 60 * 60 * 1000;

/** Null protocol IDs used when no adapter has reported back yet */
const NULL_PROTOCOL_IDS: ProtocolIds = { recordId: null, sessionId: null };

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _sessionManagerDeps = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  uuid: () => randomUUID(),
  sessionScratchDir: (projectDir: string, featureName: string, sessionId: string): string =>
    join(projectDir, ".nax", "features", featureName, "sessions", sessionId),
};

// ─────────────────────────────────────────────────────────────────────────────
// SessionManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-process session registry.
 *
 * Holds all sessions created during a nax run. Each Runner.run() call
 * operates on its own SessionManager instance — sessions do NOT persist
 * across separate nax invocations in Phase 0.
 *
 * Phase 0 dual-write protocol:
 *   1. pipeline stage calls manager.create() to get a SessionDescriptor
 *   2. adapter still creates its own ACP session (legacy sidecar)
 *   3. when adapter completes, caller calls manager.transition() with
 *      protocolIds extracted from AgentResult (Phase 0: best-effort)
 *
 * This means the manager tracks sessions but is not yet the authority
 * for session naming — the adapter still uses buildSessionName() internally.
 */
export class SessionManager implements ISessionManager {
  private readonly _sessions = new Map<string, SessionDescriptor>();

  create(options: CreateSessionOptions): SessionDescriptor {
    const now = _sessionManagerDeps.now();
    const id = `sess-${_sessionManagerDeps.uuid()}`;
    const scratchDir =
      options.scratchDir ??
      (options.projectDir && options.featureName
        ? _sessionManagerDeps.sessionScratchDir(options.projectDir, options.featureName, id)
        : undefined);

    const descriptor: SessionDescriptor = {
      id,
      role: options.role,
      state: "CREATED",
      agent: options.agent,
      workdir: options.workdir,
      featureName: options.featureName,
      storyId: options.storyId,
      protocolIds: NULL_PROTOCOL_IDS,
      handle: options.handle,
      scratchDir,
      completedStages: [],
      createdAt: now,
      lastActivityAt: now,
    };

    this._sessions.set(id, descriptor);

    getLogger().debug("session", "Session created", {
      storyId: options.storyId,
      sessionId: id,
      role: options.role,
      agent: options.agent,
    });

    return { ...descriptor };
  }

  get(id: string): SessionDescriptor | null {
    const session = this._sessions.get(id);
    return session ? { ...session } : null;
  }

  transition(id: string, to: SessionState, options?: TransitionOptions): SessionDescriptor {
    const session = this._sessions.get(id);
    if (!session) {
      throw new NaxError(`Session "${id}" not found in registry`, "SESSION_NOT_FOUND", {
        stage: "session",
        sessionId: id,
        to,
      });
    }

    const allowed = SESSION_TRANSITIONS[session.state];
    if (!allowed.includes(to)) {
      throw new NaxError(
        `Invalid session transition: ${session.state} → ${to} (session ${id})`,
        "SESSION_INVALID_TRANSITION",
        { stage: "session", sessionId: id, from: session.state, to, allowed },
      );
    }

    const now = _sessionManagerDeps.now();
    const updated: SessionDescriptor = {
      ...session,
      state: to,
      lastActivityAt: now,
    };

    if (options?.protocolIds) {
      updated.protocolIds = options.protocolIds;
    }

    if (options?.completedStage) {
      updated.completedStages = [...session.completedStages, options.completedStage];
    }

    this._sessions.set(id, updated);

    getLogger().debug("session", "Session transitioned", {
      storyId: session.storyId,
      sessionId: id,
      from: session.state,
      to,
    });

    return { ...updated };
  }

  getForStory(storyId: string): SessionDescriptor[] {
    return Array.from(this._sessions.values())
      .filter((s) => s.storyId === storyId)
      .map((s) => ({ ...s }));
  }

  listActive(): SessionDescriptor[] {
    const terminal: SessionState[] = ["COMPLETED", "FAILED"];
    return Array.from(this._sessions.values())
      .filter((s) => !terminal.includes(s.state))
      .map((s) => ({ ...s }));
  }

  sweepOrphans(ttlMs = DEFAULT_ORPHAN_TTL_MS): number {
    const cutoff = _sessionManagerDeps.nowMs() - ttlMs;
    const terminal: SessionState[] = ["COMPLETED", "FAILED"];
    let removed = 0;

    for (const [id, session] of this._sessions.entries()) {
      if (!terminal.includes(session.state)) continue;
      if (new Date(session.lastActivityAt).getTime() < cutoff) {
        this._sessions.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      getLogger().debug("session", "Swept orphan sessions", { removed });
    }

    return removed;
  }
}
