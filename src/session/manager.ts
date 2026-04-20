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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentResult, AgentRunOptions } from "../agents/types";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import type {
  CreateSessionOptions,
  ISessionManager,
  ProtocolIds,
  SessionAgentRunner,
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
  /**
   * Persist a minimal session descriptor to <scratchDir>/descriptor.json for
   * cross-iteration disk discovery (Finding 2 from the Context Engine v2
   * architecture review). Creates the scratch directory if it does not exist.
   * `handle` is omitted — it is process-bound and cannot be rehydrated.
   */
  writeDescriptor: async (scratchDir: string, descriptor: SessionDescriptor): Promise<void> => {
    await mkdir(scratchDir, { recursive: true });
    const { handle: _handle, ...persistable } = descriptor;
    await Bun.write(join(scratchDir, "descriptor.json"), JSON.stringify(persistable, null, 2));
  },
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
 * for session naming — the adapter still uses computeAcpHandle() internally.
 */
export class SessionManager implements ISessionManager {
  private readonly _sessions = new Map<string, SessionDescriptor>();

  /**
   * Fire-and-forget disk re-persistence on descriptor mutations.
   *
   * `writeDescriptor` is also called from `create()` for the initial write;
   * subsequent mutations (transition, bindHandle, handoff) must re-persist so
   * the on-disk copy stays in sync with the in-memory registry. Without this,
   * the disk descriptor freezes at CREATED state with `protocolIds: null`
   * forever, defeating cross-iteration disk discovery.
   *
   * Failures log a warning and are swallowed — disk persistence is
   * supplementary to the in-memory Map, never authoritative.
   */
  private _persistDescriptor(descriptor: SessionDescriptor): void {
    if (!descriptor.scratchDir) return;
    void _sessionManagerDeps.writeDescriptor(descriptor.scratchDir, descriptor).catch((err) => {
      getLogger().warn("session", "Failed to re-persist session descriptor", {
        storyId: descriptor.storyId,
        sessionId: descriptor.id,
        scratchDir: descriptor.scratchDir,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

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

    // Fire-and-forget descriptor write for cross-iteration/cross-invocation
    // disk discovery (Finding 2). Failures do not block session creation —
    // disk discovery is a best-effort supplement to the in-memory registry.
    if (scratchDir) {
      void _sessionManagerDeps.writeDescriptor(scratchDir, descriptor).catch((err) => {
        getLogger().warn("session", "Failed to persist session descriptor", {
          storyId: options.storyId,
          sessionId: id,
          scratchDir,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

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
    this._persistDescriptor(updated);

    getLogger().debug("session", "Session transitioned", {
      storyId: session.storyId,
      sessionId: id,
      from: session.state,
      to,
    });

    return { ...updated };
  }

  bindHandle(id: string, handle: string, protocolIds: ProtocolIds): SessionDescriptor {
    const session = this._sessions.get(id);
    if (!session) {
      throw new NaxError(`Session "${id}" not found in registry`, "SESSION_NOT_FOUND", {
        stage: "session",
        sessionId: id,
      });
    }

    const updated: SessionDescriptor = {
      ...session,
      handle,
      protocolIds,
      lastActivityAt: _sessionManagerDeps.now(),
    };

    this._sessions.set(id, updated);
    this._persistDescriptor(updated);

    getLogger().debug("session", "Session handle bound", {
      storyId: session.storyId,
      sessionId: id,
      handle,
    });

    return { ...updated };
  }

  handoff(id: string, newAgent: string, reason?: string): SessionDescriptor {
    const session = this._sessions.get(id);
    if (!session) {
      throw new NaxError(`Session "${id}" not found in registry`, "SESSION_NOT_FOUND", {
        stage: "session",
        sessionId: id,
      });
    }

    const updated: SessionDescriptor = {
      ...session,
      agent: newAgent,
      lastActivityAt: _sessionManagerDeps.now(),
    };
    this._sessions.set(id, updated);
    this._persistDescriptor(updated);

    getLogger().info("session", "Session handed off to fallback agent", {
      storyId: session.storyId,
      sessionId: id,
      fromAgent: session.agent,
      toAgent: newAgent,
      ...(reason && { reason }),
    });

    return { ...updated };
  }

  resume(storyId: string, role: import("./types").SessionRole): SessionDescriptor | null {
    const terminal: SessionState[] = ["COMPLETED", "FAILED"];
    for (const session of this._sessions.values()) {
      if (session.storyId === storyId && session.role === role && !terminal.includes(session.state)) {
        getLogger().debug("session", "Session resumed", {
          storyId,
          sessionId: session.id,
          role,
          state: session.state,
        });
        return { ...session };
      }
    }
    return null;
  }

  closeStory(storyId: string): SessionDescriptor[] {
    const terminal: SessionState[] = ["COMPLETED", "FAILED"];
    const closed: SessionDescriptor[] = [];
    const now = _sessionManagerDeps.now();

    for (const [id, session] of this._sessions.entries()) {
      if (session.storyId !== storyId) continue;
      if (terminal.includes(session.state)) continue;

      const updated: SessionDescriptor = { ...session, state: "COMPLETED", lastActivityAt: now };
      this._sessions.set(id, updated);
      this._persistDescriptor(updated);
      closed.push({ ...updated });

      getLogger().debug("session", "Session closed by closeStory", {
        storyId,
        sessionId: id,
        priorState: session.state,
      });
    }

    return closed;
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

  /**
   * Per-session lifecycle primitive — see ISessionManager for full contract.
   *
   * Bookkeeping order:
   *   1. CREATED → RUNNING (only if currently CREATED; RESUMING is left alone
   *      so rectification loops that re-enter an already-RUNNING session don't
   *      throw SESSION_INVALID_TRANSITION).
   *   2. Call the runner. Result.protocolIds (if present) is bound via
   *      bindHandle so the disk descriptor captures the audit correlation.
   *   3. RUNNING → COMPLETED on success, RUNNING → FAILED on failure. If the
   *      runner threw, we transition to FAILED and re-throw.
   */
  async runInSession(id: string, runner: SessionAgentRunner, options: AgentRunOptions): Promise<AgentResult> {
    const pre = this._sessions.get(id);
    if (!pre) {
      throw new NaxError(`Session "${id}" not found in registry`, "SESSION_NOT_FOUND", {
        stage: "session",
        sessionId: id,
      });
    }

    if (pre.state === "CREATED") {
      this.transition(id, "RUNNING");
    }

    // #591: inject onSessionEstablished so the adapter can bind protocolIds
    // eagerly — before any prompt runs. If the run is interrupted between
    // session-established and result-returned, the descriptor already
    // carries the correlation needed to resume. The caller's own callback
    // (if any) is chained afterwards so both fire.
    const callerCallback = options.onSessionEstablished;
    const injectedOptions: AgentRunOptions = {
      ...options,
      onSessionEstablished: (protocolIds, sessionName) => {
        try {
          this.bindHandle(id, sessionName, protocolIds);
        } catch (err) {
          getLogger().warn("session", "bindHandle via onSessionEstablished failed", {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        callerCallback?.(protocolIds, sessionName);
      },
    };

    let result: AgentResult;
    try {
      result = await runner(injectedOptions);
    } catch (err) {
      // Runner threw — mark session failed, then propagate.
      if (this._sessions.get(id)?.state === "RUNNING") {
        this.transition(id, "FAILED");
      }
      throw err;
    }

    // Bind protocolIds eagerly when the runner reported them. The handle is
    // the caller-known session name (stored on the descriptor by whoever
    // created it), or the runner's own derived name if it updated the
    // descriptor itself. We use the current descriptor's handle as the fallback.
    if (result.protocolIds) {
      const current = this._sessions.get(id);
      const handle = current?.handle;
      if (handle) {
        this.bindHandle(id, handle, result.protocolIds);
      } else {
        // No handle yet — persist the ids only.
        const updated: SessionDescriptor = {
          ...(current as SessionDescriptor),
          protocolIds: result.protocolIds,
          lastActivityAt: _sessionManagerDeps.now(),
        };
        this._sessions.set(id, updated);
        this._persistDescriptor(updated);
      }
    }

    const current = this._sessions.get(id);
    if (current?.state === "RUNNING") {
      this.transition(id, result.success ? "COMPLETED" : "FAILED");
    }

    return result;
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
