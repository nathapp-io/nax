/**
 * SessionManager — centralized session lifecycle for nax agent sessions.
 *
 * Owns session descriptors, naming, open/close orchestration, and single-flight
 * prompt dispatch for adapter-backed sessions.
 *
 * See: docs/specs/SPEC-session-manager-integration.md
 */

import type { AgentAdapter, AgentResult, SessionHandle, TurnResult } from "../agents/types";
import { SessionFailureError, SessionTurnError } from "../agents/types";
import { type NaxConfig, trackedSpawnDeadlines } from "../config";
import { resolvePermissions } from "../config/permissions";
import { NaxError } from "../errors";
import type { PidRegistry } from "../execution/pid-registry";
import { getLogger } from "../logger";
import { DispatchEventBus, type IDispatchEventBus } from "../runtime/dispatch-events";
import { NO_OP_INTERACTION_HANDLER } from "../runtime/no-op-interaction-handler";
import type { ProtocolIds } from "../runtime/protocol-types";
import { _sessionManagerDeps, deriveNativeTranscriptDir, resolveProjectDirFromScratchDir } from "./manager-deps";
import { runTrackedSession } from "./manager-run";
import { DEFAULT_ORPHAN_TTL_MS, sweepOrphansImpl } from "./manager-sweep";
import { selectModel } from "./model-selection";
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

export { _sessionManagerDeps } from "./manager-deps";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Null protocol IDs used when no adapter has reported back yet */
const NULL_PROTOCOL_IDS: ProtocolIds = { recordId: null, sessionId: null };

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
  private _dispatchEvents: IDispatchEventBus;
  private _defaultAgent: string;
  private _pidRegistry: PidRegistry | undefined;
  private _watchdogControllerRegistry: Map<string, () => Promise<void>> | undefined;
  /** Native transcript root, injected by `configureRuntime` — never the project tree. */
  private _transcriptRoot: string | undefined;
  private _onStreamActivity: ((event: import("../runtime/agent-stream-events").AgentStreamEvent) => void) | undefined;
  /**
   * Bookkeeping: per-session callIds whose cancel was invoked via the watchdog
   * registry. Populated by the wrapped `onActiveCall` cancel closure; consumed
   * when the adapter surfaces `cancelled: true` so we can map the failure to
   * fail-stale without cross-session contamination in parallel runs.
   */
  private readonly _watchdogCancelledCallsBySession = new Map<string, Set<string>>();
  /** Disposer for the agent.call_ended subscription; cleared in `close()` if added. */
  private _agentStreamUnsubscribe: (() => void) | undefined;

  constructor(opts?: {
    getAdapter?: (name: string) => AgentAdapter | undefined;
    config?: NaxConfig;
    dispatchEvents?: IDispatchEventBus;
    defaultAgent?: string;
  }) {
    this._getAdapter = opts?.getAdapter ?? (() => undefined);
    this._config = opts?.config;
    this._dispatchEvents = opts?.dispatchEvents ?? new DispatchEventBus();
    this._defaultAgent = opts?.defaultAgent ?? "claude";
  }

  configureRuntime(opts: {
    getAdapter?: (name: string) => AgentAdapter | undefined;
    config?: NaxConfig;
    dispatchEvents?: IDispatchEventBus;
    defaultAgent?: string;
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
    if (opts.dispatchEvents) this._dispatchEvents = opts.dispatchEvents;
    if (opts.defaultAgent) this._defaultAgent = opts.defaultAgent;
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
   * Build the `onActiveCall` callback handed to the adapter. It populates the
   * watchdog controller registry with a wrapped cancel that records the callId
   * in `_watchdogCancelledCalls` BEFORE invoking the adapter's cancel — that
   * way, when the adapter surfaces `cancelled: true`, sendPrompt can confirm
   * it was the watchdog (vs an unrelated process kill) and classify as
   * fail-stale. Returns undefined when no registry is configured.
   */
  private _buildOnActiveCall(sessionName: string): ((callId: string, cancel: () => Promise<void>) => void) | undefined {
    const registry = this._watchdogControllerRegistry;
    if (!registry) return undefined;
    return (callId, cancel) => {
      registry.set(callId, async () => {
        const cancelledCalls = this._watchdogCancelledCallsBySession.get(sessionName) ?? new Set<string>();
        cancelledCalls.add(callId);
        this._watchdogCancelledCallsBySession.set(sessionName, cancelledCalls);
        await cancel();
      });
    };
  }

  private _clearWatchdogCancelledCalls(sessionName: string): void {
    this._watchdogCancelledCallsBySession.delete(sessionName);
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
      this._persistDescriptor(updated);
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
    if (liveHandle && liveHandle.agentName === opts.agentName) {
      const liveDesc = this._findByName(name);
      if (!liveDesc || (liveDesc.state !== "COMPLETED" && liveDesc.state !== "FAILED")) {
        return liveHandle;
      }
      // Stale handle: keepOpen left it in _liveHandles but runTrackedSession already
      // transitioned the descriptor to a terminal state. Remove it so the full open path runs.
      this._liveHandles.delete(name);
    }

    const adapter = this._getAdapter(opts.agentName);
    if (!adapter) {
      throw new NaxError(
        `SessionManager.openSession: no adapter found for agent "${opts.agentName}"`,
        "ADAPTER_NOT_FOUND",
        { stage: "session", agentName: opts.agentName },
      );
    }

    const resolvedPermissions = resolvePermissions(opts.config ?? this._config, opts.pipelineStage);
    const compaction = (opts.config ?? this._config)?.execution?.compaction;
    const existingDescriptor = this._findByName(name);
    const resume = existingDescriptor !== undefined;

    const handle = await adapter.openSession(name, {
      agentName: opts.agentName,
      workdir: opts.workdir,
      resolvedPermissions,
      compaction,
      ...selectModel(opts),
      timeoutSeconds: opts.timeoutSeconds,
      onPidSpawned: this._pidRegistry ? (pid) => this._pidRegistry?.register(pid) : undefined,
      onPidExited: this._pidRegistry ? (pid) => this._pidRegistry?.unregister(pid) : undefined,
      onSessionEstablished: opts.onSessionEstablished,
      signal: opts.signal,
      resume,
      onActiveCall: this._buildOnActiveCall(name),
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
    this._clearWatchdogCancelledCalls(handle.id);
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

    this._busySessions.add(handle.id);

    try {
      const result = await adapter.sendTurn(handle, prompt, {
        interactionHandler: opts?.interactionHandler ?? NO_OP_INTERACTION_HANDLER,
        signal: opts?.signal,
        maxInteractions: opts?.maxInteractions,
        contextPullTools: opts?.contextPullTools,
        codingTools: opts?.codingTools,
      });
      return { ...result, protocolIds: result.protocolIds ?? handle.protocolIds };
    } catch (err) {
      // Map the adapter's transport-level cancel signal to the policy-level
      // outcome. `SessionTurnError.cancelled === true` means the adapter's
      // cancelActivePrompt() was invoked. If we are confident _we_ triggered
      // the cancel (callId present in _watchdogCancelledCalls), classify as
      // fail-stale; otherwise it was an unrelated external kill — pass through.
      if (err instanceof SessionTurnError && err.cancelled) {
        // Drain the bookkeeping set: any callId tied to this handle that we
        // recorded as watchdog-cancelled is the one we just observed. Drain
        // all of them — there should only be one in-flight call per handle
        // due to the single-flight (_busySessions) invariant above.
        const wasWatchdog = (this._watchdogCancelledCallsBySession.get(handle.id)?.size ?? 0) > 0;
        if (wasWatchdog) {
          throw new SessionFailureError("idle watchdog cancelled session — no stream activity", {
            category: "availability",
            outcome: "fail-stale",
            retriable: true,
            message: "idle watchdog cancelled session — no stream activity",
            reason: "idle-watchdog",
          });
        }
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
      this._clearWatchdogCancelledCalls(handle.id);
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
        // Forwarded whole: every SendPromptOpts member is optional and present
        // on RunInSessionOpts, and sendPrompt re-picks fields explicitly — so
        // new SendPromptOpts fields (e.g. codingTools) cannot be silently
        // dropped here. manager.ts is past its file-size baseline; do not grow.
        return await this.sendPrompt(handle, promptOrFnOrRunner, opts);
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
    return runTrackedSession(
      {
        sessions: this._sessions,
        transition: (sid, to, opts) => this.transition(sid, to, opts),
        bindHandle: (sid, handle, protocolIds) => this.bindHandle(sid, handle, protocolIds),
        handoff: (sid, agent, reason) => this.handoff(sid, agent, reason),
        persistDescriptor: (desc) => this._persistDescriptor(desc),
        dispatchEvents: this._dispatchEvents,
        defaultAgent: this._defaultAgent,
        nameFor: (req) => this.nameFor(req),
      },
      id,
      runner,
      request,
    );
  }

  sweepOrphans(ttlMs = DEFAULT_ORPHAN_TTL_MS): number {
    return sweepOrphansImpl(this._sessions, ttlMs);
  }

  close(): void {
    this._agentStreamUnsubscribe?.();
    this._agentStreamUnsubscribe = undefined;
  }
}
