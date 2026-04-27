/**
 * SessionManager — centralized session lifecycle for nax agent sessions.
 *
 * Owns session descriptors, naming, open/close orchestration, and single-flight
 * prompt dispatch for adapter-backed sessions.
 *
 * See: docs/specs/SPEC-session-manager-integration.md
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { AgentAdapter, AgentResult, SessionHandle, TurnResult } from "../agents/types";
import type { NaxConfig } from "../config";
import { resolvePermissions } from "../config/permissions";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { NO_OP_INTERACTION_HANDLER } from "../runtime/no-op-interaction-handler";
import type { ProtocolIds } from "../runtime/protocol-types";
import { formatSessionName } from "./naming";
import type {
  CreateSessionOptions,
  ISessionManager,
  NameForRequest,
  OpenSessionRequest,
  RunInSessionOpts,
  SendPromptOpts,
  SessionDescriptor,
  SessionManagedRunRequest,
  SessionRunClient,
  SessionRunOptions,
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
  writeDescriptor: async (scratchDir: string, descriptor: SessionDescriptor, projectDir?: string): Promise<void> => {
    await mkdir(scratchDir, { recursive: true });
    const { handle: _handle, ...persistable } = descriptor;
    const derivedProjectDir = projectDir ?? resolveProjectDirFromScratchDir(scratchDir);
    if (derivedProjectDir) {
      persistable.workdir = toProjectRelativePath(derivedProjectDir, persistable.workdir);
      if (persistable.scratchDir) {
        persistable.scratchDir = toProjectRelativePath(derivedProjectDir, persistable.scratchDir);
      }
    }
    await Bun.write(join(scratchDir, "descriptor.json"), JSON.stringify(persistable, null, 2));
  },
};

function resolveProjectDirFromScratchDir(scratchDir: string): string | undefined {
  const marker = `${sep}.nax${sep}features${sep}`;
  const markerIdx = scratchDir.lastIndexOf(marker);
  if (markerIdx > 0) return scratchDir.slice(0, markerIdx);

  // Backstop: tolerate persisted forward-slash paths regardless of platform.
  const posixIdx = scratchDir.lastIndexOf("/.nax/features/");
  if (posixIdx > 0) return scratchDir.slice(0, posixIdx);

  return undefined;
}

function toProjectRelativePath(projectDir: string, pathValue: string): string {
  const relativePath = isAbsolute(pathValue) ? relative(projectDir, pathValue) : pathValue;
  return relativePath === "" ? "." : relativePath;
}

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
 * The manager is the framework authority for session naming and lifecycle.
 * The adapter still keeps the protocol-specific handle formula internally
 * so non-session adapter APIs can derive matching ACP names when needed.
 */
export class SessionManager implements ISessionManager {
  private readonly _sessions = new Map<string, SessionDescriptor>();
  private readonly _busySessions = new Set<string>();
  private readonly _cancelledSessions = new Set<string>();
  private readonly _liveHandles = new Map<string, SessionHandle>();
  private _getAdapter: (name: string) => AgentAdapter | undefined;
  private _config: NaxConfig | undefined;

  constructor(opts?: {
    getAdapter?: (name: string) => AgentAdapter | undefined;
    config?: NaxConfig;
  }) {
    this._getAdapter = opts?.getAdapter ?? (() => undefined);
    this._config = opts?.config;
  }

  configureRuntime(opts: {
    getAdapter?: (name: string) => AgentAdapter | undefined;
    config?: NaxConfig;
  }): void {
    if (opts.getAdapter) this._getAdapter = opts.getAdapter;
    if (opts.config) this._config = opts.config;
  }

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
    const projectDir = resolveProjectDirFromScratchDir(descriptor.scratchDir);
    void _sessionManagerDeps.writeDescriptor(descriptor.scratchDir, descriptor, projectDir).catch((err) => {
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
      const projectDir = options.projectDir ?? resolveProjectDirFromScratchDir(scratchDir);
      void _sessionManagerDeps.writeDescriptor(scratchDir, descriptor, projectDir).catch((err) => {
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

  // ─── Phase B: new primitive methods ────────────────────────────────────────

  private _findByName(name: string): SessionDescriptor | undefined {
    for (const session of this._sessions.values()) {
      if (session.handle === name) return session;
    }
    return undefined;
  }

  descriptor(name: string): SessionDescriptor | null {
    const session = this._findByName(name);
    return session ? { ...session } : null;
  }

  nameFor(req: NameForRequest): string {
    return formatSessionName(req);
  }

  async openSession(name: string, opts: OpenSessionRequest): Promise<SessionHandle> {
    const liveHandle = this._liveHandles.get(name);
    if (liveHandle && liveHandle.agentName === opts.agentName) {
      return liveHandle;
    }

    const adapter = this._getAdapter(opts.agentName);
    if (!adapter) {
      throw new NaxError(
        `SessionManager.openSession: no adapter found for agent "${opts.agentName}"`,
        "ADAPTER_NOT_FOUND",
        { stage: "session", agentName: opts.agentName },
      );
    }

    const resolvedPermissions = resolvePermissions(this._config, opts.pipelineStage);
    const existingDescriptor = this._findByName(name);
    const resume = existingDescriptor !== undefined;

    const handle = await adapter.openSession(name, {
      agentName: opts.agentName,
      workdir: opts.workdir,
      resolvedPermissions,
      modelDef: opts.modelDef,
      timeoutSeconds: opts.timeoutSeconds,
      onPidSpawned: opts.onPidSpawned,
      onSessionEstablished: opts.onSessionEstablished,
      signal: opts.signal,
      resume,
    });
    this._liveHandles.set(name, handle);

    const protocolIds = handle.protocolIds ?? NULL_PROTOCOL_IDS;

    if (!existingDescriptor) {
      const created = this.create({
        role: opts.role ?? "main",
        agent: opts.agentName,
        workdir: opts.workdir,
        featureName: opts.featureName,
        storyId: opts.storyId,
        handle: name,
      });
      this.transition(created.id, "RUNNING", { protocolIds });
    } else if (existingDescriptor.state === "CREATED") {
      this.transition(existingDescriptor.id, "RUNNING", { protocolIds });
    } else if (existingDescriptor.state === "COMPLETED" || existingDescriptor.state === "FAILED") {
      // Terminal → RUNNING is not a valid state-machine transition, so bypass
      // transition() and update directly (same pattern as closeStory).
      // Also clear the cancelled flag in case this session was previously cancelled
      // before reaching terminal state, so sendPrompt does not immediately throw.
      this._cancelledSessions.delete(name);
      const updated: SessionDescriptor = {
        ...existingDescriptor,
        state: "RUNNING",
        protocolIds,
        lastActivityAt: _sessionManagerDeps.now(),
      };
      this._sessions.set(existingDescriptor.id, updated);
      this._persistDescriptor(updated);
    } else {
      // RUNNING: session is already active — no-op for the descriptor, but warn
      // so callers can detect missing closeSession calls (single-flight invariant).
      getLogger().warn("session", "openSession called on already-RUNNING session", {
        storyId: opts.storyId,
        sessionName: name,
      });
    }

    getLogger().debug("session", "Session opened via SessionManager", {
      storyId: opts.storyId,
      sessionName: name,
      agentName: opts.agentName,
      resume,
    });

    return handle;
  }

  async closeSession(handle: SessionHandle): Promise<void> {
    const desc = this._findByName(handle.id);
    const adapter = this._getAdapter(handle.agentName);
    this._liveHandles.delete(handle.id);

    if (adapter) {
      try {
        await adapter.closeSession(handle);
      } catch (err) {
        getLogger().warn("session", "adapter.closeSession failed (swallowed)", {
          storyId: desc?.storyId,
          sessionName: handle.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (desc && desc.state === "RUNNING") {
      this.transition(desc.id, "COMPLETED");
    }

    this._busySessions.delete(handle.id);
    this._cancelledSessions.delete(handle.id);
  }

  async sendPrompt(handle: SessionHandle, prompt: string, opts?: SendPromptOpts): Promise<TurnResult> {
    if (this._cancelledSessions.has(handle.id)) {
      throw new NaxError(
        `Session "${handle.id}" was cancelled — close it and open a new session to continue`,
        "SESSION_CANCELLED",
        { stage: "session", sessionName: handle.id },
      );
    }

    if (this._busySessions.has(handle.id)) {
      throw new NaxError(
        `Session "${handle.id}" is already processing a prompt (single-flight invariant)`,
        "SESSION_BUSY",
        { stage: "session", sessionName: handle.id },
      );
    }

    const adapter = this._getAdapter(handle.agentName);
    if (!adapter) {
      throw new NaxError(
        `SessionManager.sendPrompt: no adapter found for agent "${handle.agentName}"`,
        "ADAPTER_NOT_FOUND",
        { stage: "session", agentName: handle.agentName },
      );
    }

    this._busySessions.add(handle.id);

    try {
      return await adapter.sendTurn(handle, prompt, {
        interactionHandler: opts?.interactionHandler ?? NO_OP_INTERACTION_HANDLER,
        signal: opts?.signal,
        maxTurns: opts?.maxTurns,
      });
    } catch (err) {
      // Check signal.aborted OR an AbortError thrown by the adapter to avoid
      // false-positive cancellation when a non-abort error races with an
      // incidentally-aborted signal from an unrelated controller.
      if (opts?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        this._cancelledSessions.add(handle.id);
        const desc = this._findByName(handle.id);
        if (desc && desc.state === "RUNNING") {
          this.transition(desc.id, "FAILED");
        }
      }
      throw err;
    } finally {
      this._busySessions.delete(handle.id);
    }
  }

  // ─── runInSession: prompt + callback overloads ──────────────────────────────

  /**
   * Tracked-session form — preserves descriptor lifecycle bookkeeping for
   * callers that still provide a run client rather than direct prompt/callback
   * usage. The session layer stays peer-oriented by depending only on the
   * structural `run(request)` surface.
   */
  async runInSession(
    id: string,
    runner: SessionRunClient,
    request: SessionManagedRunRequest,
    options?: SessionRunOptions,
  ): Promise<AgentResult>;
  /** Phase B prompt form — open, sendPrompt, close (try/finally). */
  async runInSession(name: string, prompt: string, opts: RunInSessionOpts): Promise<TurnResult>;
  /** Phase B callback form — open, run callback with live handle, close (try/finally). */
  async runInSession<T>(name: string, runFn: (handle: SessionHandle) => Promise<T>, opts: RunInSessionOpts): Promise<T>;
  async runInSession(
    idOrName: string,
    promptOrFnOrRunner: string | ((handle: SessionHandle) => Promise<unknown>) | SessionRunClient,
    optsOrRequest: RunInSessionOpts | SessionManagedRunRequest,
    _legacyOptions?: SessionRunOptions,
  ): Promise<TurnResult | AgentResult | unknown> {
    if (
      typeof promptOrFnOrRunner === "object" &&
      promptOrFnOrRunner !== null &&
      "run" in promptOrFnOrRunner &&
      typeof promptOrFnOrRunner.run === "function"
    ) {
      return this._runTrackedSession(
        idOrName,
        promptOrFnOrRunner as SessionRunClient,
        optsOrRequest as SessionManagedRunRequest,
      );
    }

    const opts = optsOrRequest as RunInSessionOpts;
    const handle = await this.openSession(idOrName, opts);

    try {
      if (typeof promptOrFnOrRunner === "string") {
        return await this.sendPrompt(handle, promptOrFnOrRunner, {
          interactionHandler: opts.interactionHandler,
          signal: opts.signal,
          maxTurns: opts.maxTurns,
        });
      }
      return await (promptOrFnOrRunner as (h: SessionHandle) => Promise<unknown>)(handle);
    } finally {
      await this.closeSession(handle);
    }
  }

  private async _runTrackedSession(
    id: string,
    runner: SessionRunClient,
    request: SessionManagedRunRequest,
  ): Promise<AgentResult> {
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

    const callerCallback = request.runOptions.onSessionEstablished;
    const injectedRequest: SessionManagedRunRequest = {
      ...request,
      runOptions: {
        ...request.runOptions,
        onSessionEstablished: (protocolIds, sessionName) => {
          try {
            this.bindHandle(id, sessionName, protocolIds);
          } catch (err) {
            getLogger().warn("session", "bindHandle via onSessionEstablished failed", {
              storyId: this._sessions.get(id)?.storyId,
              sessionId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          callerCallback?.(protocolIds, sessionName);
        },
      },
    };

    const config = request.runOptions.config;
    const maxRetriable = config?.execution?.sessionErrorRetryableMaxRetries ?? 3;
    const maxNonRetriable = config?.execution?.sessionErrorMaxRetries ?? 1;
    let sessionRetries = 0;

    let result: AgentResult;
    while (true) {
      try {
        result = await runner.run(injectedRequest);
      } catch (err) {
        if (this._sessions.get(id)?.state === "RUNNING") {
          this.transition(id, "FAILED");
        }
        throw err;
      }

      if (result.adapterFailure?.outcome === "fail-adapter-error") {
        const max = result.adapterFailure.retriable ? maxRetriable : maxNonRetriable;
        if (sessionRetries < max && !request.signal?.aborted) {
          sessionRetries++;
          getLogger().warn("session", "Session transport error — retrying with fresh session", {
            sessionId: id,
            storyId: this._sessions.get(id)?.storyId,
            retriable: result.adapterFailure.retriable,
            attempt: sessionRetries,
            maxAttempts: max,
          });
          continue;
        }
      }
      break;
    }

    if (result.protocolIds) {
      const current = this._sessions.get(id);
      const handle = current?.handle;
      if (handle) {
        this.bindHandle(id, handle, result.protocolIds);
      } else if (current) {
        const updated: SessionDescriptor = {
          ...current,
          protocolIds: result.protocolIds,
          lastActivityAt: _sessionManagerDeps.now(),
        };
        this._sessions.set(id, updated);
        this._persistDescriptor(updated);
      }
    }

    const finalAgent = result.agentFallbacks?.at(-1)?.newAgent;
    if (finalAgent) {
      const current = this._sessions.get(id);
      if (current && finalAgent !== current.agent) {
        this.handoff(id, finalAgent, "post-run-reconcile");
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
