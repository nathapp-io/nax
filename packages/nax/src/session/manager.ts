/**
 * SessionManager — centralized session lifecycle for nax agent sessions.
 *
 * Owns session descriptors, naming, open/close orchestration, and single-flight
 * prompt dispatch for adapter-backed sessions.
 *
 * See: docs/specs/SPEC-session-manager-integration.md
 */

import type { ProtocolIds } from "@nathapp/nax-agent";
import { NO_OP_INTERACTION_HANDLER } from "@nathapp/nax-agent";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import type { AgentAdapter, SessionHandle, TurnResult } from "../agents/types";
import { SessionFailureError } from "../agents/types";
import { type NaxConfig, trackedSpawnDeadlines } from "../config";
import { resolvePermissions } from "../config/permissions";
import { NaxError } from "../errors";
import type { PidRegistry } from "../execution/pid-registry";
import { getLogger } from "../logger";
import { decideReuse } from "./endpoint-identity";
import {
  buildLoopHandlerTurnOpts,
  LOOP_HANDLERS_NATIVE_ONLY_MESSAGE,
  shouldLogNativeOnlyScope,
} from "./loop-handler-forwarding";
import {
  _sessionManagerDeps,
  deriveNativeTranscriptDir,
  persistDescriptor,
  resolveProjectDirFromScratchDir,
} from "./manager-deps";
import { DEFAULT_ORPHAN_TTL_MS, sweepOrphansImpl } from "./manager-sweep";
import { selectModel } from "./model-selection";
import { formatSessionName } from "./naming";
import { selectNativeTurnConfig } from "./turn-config-selection";
import type {
  CreateSessionOptions,
  ISessionManager,
  NameForRequest,
  OpenSessionRequest,
  RunInSessionOpts,
  SendPromptOpts,
  SessionDescriptor,
  SessionState,
  TransitionOptions,
} from "./types";
import { SESSION_TRANSITIONS } from "./types";
import { WatchdogCancelTracker } from "./watchdog-cancel-tracker";
import { isWatchdogCancelledTurn } from "./watchdog-turn-classification";

export { _sessionManagerDeps } from "./manager-deps";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Null protocol IDs used when no adapter has reported back yet */
const NULL_PROTOCOL_IDS: ProtocolIds = { recordId: null, sessionId: null };

/** An empty loop-handler set — the default until run setup delivers one (US-004). */
const NO_LOOP_HANDLERS: LoopHandlerSet = Object.freeze([]);

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
  private _pidRegistry: PidRegistry | undefined;
  private _watchdogControllerRegistry: Map<string, () => Promise<void>> | undefined;
  /** Native transcript root, injected by `configureRuntime` — never the project tree. */
  private _transcriptRoot: string | undefined;
  private _onStreamActivity: ((event: import("../runtime/agent-stream-events").AgentStreamEvent) => void) | undefined;
  /**
   * The run's plugin loop handlers, delivered once by
   * `initializeAfterLock` through `configureLoopHandlers` (US-004). Empty until
   * then, and for a manager no run setup ever configured.
   */
  private _loopHandlers: LoopHandlerSet = NO_LOOP_HANDLERS;
  /** Whether the native-only scope line has already been logged for this manager. */
  private _loopHandlerScopeLogged = false;
  /**
   * Watchdog-invoked cancels, per session — populated by the wrapped
   * `onActiveCall` cancel closure; consumed when the adapter surfaces
   * `cancelled: true` so we can map the failure to fail-stale without
   * cross-session contamination in parallel runs.
   */
  private readonly _watchdogCancels = new WatchdogCancelTracker();
  /** Disposer for the agent.call_ended subscription; cleared in `close()` if added. */
  private _agentStreamUnsubscribe: (() => void) | undefined;

  constructor(opts?: { getAdapter?: (name: string) => AgentAdapter | undefined; config?: NaxConfig }) {
    this._getAdapter = opts?.getAdapter ?? (() => undefined);
    this._config = opts?.config;
  }

  configureRuntime(opts: {
    getAdapter?: (name: string) => AgentAdapter | undefined;
    config?: NaxConfig;
    pidRegistry?: PidRegistry;
    watchdogControllerRegistry?: Map<string, () => Promise<void>>;
    onStreamActivity?: (event: import("../runtime/agent-stream-events").AgentStreamEvent) => void;
    /** Native transcript root (sibling of `runs/`) — see `deriveNativeTranscriptDir` in manager-deps.ts. */
    transcriptRoot?: string;
    /**
     * Stream event bus. SessionManager subscribes once to depopulate the
     * watchdog registry on `agent.call_ended` (event-driven cleanup, no
     * per-call callback needed).
     */
    agentStreamEvents?: import("../runtime/agent-stream-events").IAgentStreamEventBus;
  }): void {
    if (opts.getAdapter) this._getAdapter = opts.getAdapter;
    if (opts.config) this._config = opts.config;
    if (opts.pidRegistry) this._pidRegistry = opts.pidRegistry;
    if (opts.watchdogControllerRegistry) this._watchdogControllerRegistry = opts.watchdogControllerRegistry;
    if (opts.onStreamActivity) this._onStreamActivity = opts.onStreamActivity;
    if (opts.transcriptRoot) this._transcriptRoot = opts.transcriptRoot;
    if (opts.agentStreamEvents) {
      this._agentStreamUnsubscribe?.();
      this._agentStreamUnsubscribe = opts.agentStreamEvents.onAgentStream((event) => {
        if (event.kind === "agent.call_ended") {
          // Only clean up the controller registry here. Do NOT drain
          // _watchdogCancelledCalls from this subscriber: agent.call_ended is
          // emitted synchronously inside SpawnAcpSession.prompt() before the
          // error propagates into sendPrompt. Draining here would clear the flag
          // before sendPrompt checks it, preventing fail-stale classification.
          // _watchdogCancelledCalls is drained by sendPrompt instead (on both
          // the error path and the success path to prevent stale entries).
          this._watchdogControllerRegistry?.delete(event.callId);
        }
      });
    }
  }

  /**
   * Store the run's plugin loop handlers for this manager's turns (US-004).
   * Called once at run setup with `PluginRegistry.getLoopHandlers()` —
   * `sendPrompt` forwards them to the native adapter's `sendTurn`. Sessions on
   * any other agent ignore them.
   */
  configureLoopHandlers(set: LoopHandlerSet): void {
    this._loopHandlers = set;
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
    persistDescriptor(updated);

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
    persistDescriptor(updated);

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
    persistDescriptor(updated);

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
      persistDescriptor(updated);
      this._sessions.delete(id);
      if (updated.handle) this._liveHandles.delete(updated.handle);
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

  getLiveHandle(name: string): SessionHandle | undefined {
    return this._liveHandles.get(name);
  }

  isCancelled(name: string): boolean {
    return this._cancelledSessions.has(name);
  }

  async openSession(name: string, opts: OpenSessionRequest): Promise<SessionHandle> {
    // RACE-37: synchronous single-flight guard for the open path. Without
    // this, two concurrent openSession(name) calls both pass the
    // _liveHandles.get check, both await adapter.openSession (which
    // spawns a real acpx process), and the loser overwrites the winner
    // in _liveHandles on the line below — orphaning the first physical
    // session until TTL/forceStop. Mirror the _busySessions pattern.
    if (this._busySessions.has(name)) {
      throw new NaxError(`Session "${name}" is already being opened (single-flight invariant)`, "SESSION_BUSY", {
        stage: "session",
        sessionName: name,
      });
    }
    this._busySessions.add(name);

    try {
      const handle = await this.openSessionImpl(name, opts);
      return handle;
    } finally {
      this._busySessions.delete(name);
    }
  }

  private async openSessionImpl(name: string, opts: OpenSessionRequest): Promise<SessionHandle> {
    const liveHandle = this._liveHandles.get(name);
    const reuse = decideReuse(liveHandle, this._findByName(name), opts);
    if (liveHandle && reuse === "reuse") return liveHandle;
    if (liveHandle && reuse === "close-then-reopen") {
      // closeSession clears _busySessions for this name; openSession set that marker
      // as its single-flight guard and still needs it for the rest of this open.
      await this.closeSession(liveHandle);
      this._busySessions.add(name);
    } else if (liveHandle) this._liveHandles.delete(name);

    const adapter = this._getAdapter(opts.agentName);
    if (!adapter) {
      throw new NaxError(
        `SessionManager.openSession: no adapter found for agent "${opts.agentName}"`,
        "ADAPTER_NOT_FOUND",
        { stage: "session", agentName: opts.agentName },
      );
    }

    const resolvedPermissions = resolvePermissions(opts.config ?? this._config, opts.pipelineStage);
    const existingDescriptor = this._findByName(name);
    const resume = existingDescriptor !== undefined;

    const handle = await adapter.openSession(name, {
      agentName: opts.agentName,
      workdir: opts.workdir,
      resolvedPermissions,
      ...selectNativeTurnConfig(opts.config ?? this._config),
      ...selectModel(opts),
      timeoutSeconds: opts.timeoutSeconds,
      onPidSpawned: this._pidRegistry ? (pid) => this._pidRegistry?.register(pid) : undefined,
      onPidExited: this._pidRegistry ? (pid) => this._pidRegistry?.unregister(pid) : undefined,
      onSessionEstablished: opts.onSessionEstablished,
      signal: opts.signal,
      resume,
      onActiveCall: this._watchdogCancels.buildOnActiveCall(name, this._watchdogControllerRegistry),
      onStreamActivity: this._onStreamActivity,
      // Finding 1: callers never supplied transcriptDir, so derive it here — the one place ADR-028 §3
      // documents. An explicit caller value wins. transcriptOwner is nax#1877's ownership key.
      transcriptDir:
        opts.transcriptDir ??
        deriveNativeTranscriptDir({ featureName: opts.featureName, transcriptRoot: this._transcriptRoot }),
      ...(opts.transcriptOwner !== undefined ? { transcriptOwner: opts.transcriptOwner } : {}),
      ...trackedSpawnDeadlines(this._config), // #1583
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
      persistDescriptor(updated);
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
    this._watchdogCancels.clear(handle.id);
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

    const terminalDesc = this._findByName(handle.id);
    if (terminalDesc && (terminalDesc.state === "COMPLETED" || terminalDesc.state === "FAILED")) {
      throw new NaxError(
        `Session "${handle.id}" is in terminal state ${terminalDesc.state} — call openSession first to resume`,
        "SESSION_TERMINAL_STATE",
        { stage: "session", sessionName: handle.id, state: terminalDesc.state },
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

    // US-004: deliver the run's plugin loop handlers to this turn. A session on
    // any other agent gets neither key, and a non-empty set reaching a
    // non-native session is worth saying once — the native loop is the only
    // consumer, so those handlers can never fire here.
    const loopHandlerOpts = buildLoopHandlerTurnOpts({ handle, descriptor: terminalDesc, set: this._loopHandlers });
    if (shouldLogNativeOnlyScope(this._loopHandlers, handle, this._loopHandlerScopeLogged)) {
      this._loopHandlerScopeLogged = true;
      getLogger().info("plugins", LOOP_HANDLERS_NATIVE_ONLY_MESSAGE, { sessionName: handle.id });
    }

    this._busySessions.add(handle.id);

    try {
      const result = await adapter.sendTurn(handle, prompt, {
        ...opts,
        interactionHandler: opts?.interactionHandler ?? NO_OP_INTERACTION_HANDLER,
        ...loopHandlerOpts,
      });
      return { ...result, protocolIds: result.protocolIds ?? handle.protocolIds };
    } catch (err) {
      // The watchdog's own cancel IS fail-stale — ACP surfaces it as
      // SessionTurnError(cancelled:true), native as a plain AbortError
      // (nax#2218). Anything else is an unrelated kill: pass through.
      if (
        isWatchdogCancelledTurn({
          watchdogFired: this._watchdogCancels.hasCancelled(handle.id),
          err,
          signalAborted: opts?.signal?.aborted === true,
        })
      ) {
        throw new SessionFailureError("idle watchdog cancelled session — no stream activity", {
          category: "availability",
          outcome: "fail-stale",
          retriable: true,
          message: "idle watchdog cancelled session — no stream activity",
          reason: "idle-watchdog",
        });
      }
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
      // Clear per-session watchdog-cancel bookkeeping after each turn: this
      // call is complete (success or error), and single-flight is per session.
      this._watchdogCancels.clear(handle.id);
      this._busySessions.delete(handle.id);
    }
  }

  // ─── runInSession: prompt + callback overloads ──────────────────────────────

  /** Phase B prompt form — open, sendPrompt, close (try/finally). */
  async runInSession(name: string, prompt: string, opts: RunInSessionOpts): Promise<TurnResult>;
  /** Phase B callback form — open, run callback with live handle, close (try/finally). */
  async runInSession<T>(name: string, runFn: (handle: SessionHandle) => Promise<T>, opts: RunInSessionOpts): Promise<T>;
  async runInSession(
    name: string,
    promptOrFn: string | ((handle: SessionHandle) => Promise<unknown>),
    opts: RunInSessionOpts,
  ): Promise<TurnResult | unknown> {
    const handle = await this.openSession(name, opts);

    try {
      if (typeof promptOrFn === "string") {
        // Forwarded whole: every SendPromptOpts member is optional and present
        // on RunInSessionOpts, and sendPrompt spreads ...opts — so new
        // SendPromptOpts fields (e.g. codingTools) cannot be silently dropped
        // here. manager.ts is past its file-size baseline; do not grow.
        return await this.sendPrompt(handle, promptOrFn, opts);
      }
      return await promptOrFn(handle);
    } finally {
      await this.closeSession(handle);
    }
  }

  sweepOrphans(ttlMs = DEFAULT_ORPHAN_TTL_MS): number {
    return sweepOrphansImpl(this._sessions, ttlMs);
  }

  close(): void {
    this._agentStreamUnsubscribe?.();
    this._agentStreamUnsubscribe = undefined;
  }
}
