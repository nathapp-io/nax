/**
 * Session Manager Types
 *
 * Centralized session lifecycle for nax agent sessions.
 * Replaces the per-adapter sidecar pattern (Phase 5.5 migration target).
 *
 * See: docs/specs/SPEC-session-manager-integration.md
 */
import type { ProtocolIds } from "../runtime/protocol-types";
import type { SessionRole } from "../runtime/session-role";
export type { SessionRole, CanonicalSessionRole } from "../runtime/session-role";
export { isSessionRole, KNOWN_SESSION_ROLES } from "../runtime/session-role";

// ─────────────────────────────────────────────────────────────────────────────
// State machine — 7 states
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session lifecycle states.
 *
 * Valid transitions:
 *   CREATED   → RUNNING
 *   RUNNING   → PAUSED | COMPLETED | FAILED | CLOSING
 *   PAUSED    → RESUMING | FAILED
 *   RESUMING  → RUNNING | FAILED
 *   CLOSING   → COMPLETED | FAILED
 *   COMPLETED → (terminal)
 *   FAILED    → (terminal)
 */
export type SessionState =
  | "CREATED" // Session descriptor created, no agent spawned yet
  | "RUNNING" // Agent is actively processing
  | "PAUSED" // Mid-task pause (queue PAUSE command)
  | "RESUMING" // Recovering from crash or reconnecting
  | "CLOSING" // Graceful close in progress
  | "COMPLETED" // Finished successfully (terminal)
  | "FAILED"; // Terminated with error (terminal)

/** Valid transitions map — terminal states have empty arrays */
export const SESSION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ["RUNNING"],
  RUNNING: ["PAUSED", "COMPLETED", "FAILED", "CLOSING"],
  PAUSED: ["RESUMING", "FAILED"],
  RESUMING: ["RUNNING", "FAILED"],
  CLOSING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Session roles — re-exported from SSOT (src/runtime/session-role.ts)
// ─────────────────────────────────────────────────────────────────────────────
// SessionRole, CanonicalSessionRole, KNOWN_SESSION_ROLES, isSessionRole
// are re-exported at the top of this file from src/runtime/session-role.

// ─────────────────────────────────────────────────────────────────────────────
// SessionDescriptor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete descriptor for a nax agent session.
 * The SessionManager is the single source of truth for all active sessions.
 */
export interface SessionDescriptor {
  /** nax-internal session ID: `sess-<uuid>` */
  id: string;
  /** Purpose of this session */
  role: SessionRole;
  /** Current lifecycle state */
  state: SessionState;
  /** Agent name (e.g. "claude", "codex") */
  agent: string;
  /** Working directory this session is bound to */
  workdir: string;
  /** Feature name for session naming and log correlation */
  featureName?: string;
  /** Story this session is executing (undefined for feature-level sessions) */
  storyId?: string;
  /**
   * Protocol-level IDs from the acpx adapter.
   * Populated after the first successful agent.run() or agent.complete() call.
   */
  protocolIds: ProtocolIds;
  /**
   * ACP session handle (name) — the string passed to acpx as --session.
   * Format: nax-<hash8>-<feature>-<storyId>-<role>
   * Used by the adapter to resume the physical ACP session.
   */
  handle?: string;
  /**
   * Absolute path to this session's scratch directory.
   * Populated by the manager when create() is called.
   * Phase 1: written by verify/rectify/review/autofix, read by SessionScratchProvider.
   */
  scratchDir?: string;
  /**
   * Pipeline stages that have completed in this session.
   * Used by SessionScratchProvider to determine what scratch data is available.
   */
  completedStages: string[];
  /** ISO timestamp when the session was created */
  createdAt: string;
  /**
   * ISO timestamp of last activity.
   * Used by sweepOrphans() to detect dead sessions.
   */
  lastActivityAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manager interface
// ─────────────────────────────────────────────────────────────────────────────

/** Options for creating a new session */
export interface CreateSessionOptions {
  role: SessionRole;
  agent: string;
  workdir: string;
  projectDir?: string;
  featureName?: string;
  storyId?: string;
  handle?: string;
  /**
   * Absolute path to this session's scratch directory (Phase 1+).
   * When provided, the manager stores it on the descriptor so callers can
   * retrieve it via get() or getForStory() without recomputing the path.
   */
  scratchDir?: string;
}

/** Options for transitioning session state */
export interface TransitionOptions {
  protocolIds?: ProtocolIds;
  completedStage?: string;
}

/** Per-session agent runner — see SessionManager.runInSession for contract. */
export type SessionAgentRunner = (
  options: import("../agents/types").AgentRunOptions,
) => Promise<import("../agents/types").AgentResult>;

export interface SessionManagedRunRequest {
  runOptions: import("../agents/types").AgentRunOptions;
  signal?: AbortSignal;
}

export interface SessionRunClient {
  run(request: SessionManagedRunRequest): Promise<import("../agents/types").AgentResult>;
}

/**
 * Options for SessionManager.runInSession (ADR-013 Phase 1).
 * Reserved for Phase 2 retry limits and abort signal overrides. Currently unused.
 */
// biome-ignore lint/complexity/noBannedTypes: reserved empty interface for Phase 2 extensions
export type SessionRunOptions = {};

/**
 * Input to SessionManager.openSession — the SessionManager-level API.
 * Takes pipelineStage so SessionManager can resolve permissions before
 * forwarding to the adapter (the adapter receives ResolvedPermissions).
 */
export interface OpenSessionRequest {
  /** Agent name (e.g. "claude"). */
  agentName: string;
  /** Logical role of the session for naming/descriptor correlation. */
  role?: SessionRole;
  /** Working directory for the session. */
  workdir: string;
  /** Pipeline stage — used by SessionManager to call resolvePermissions. */
  pipelineStage: import("../config/permissions").PipelineStage;
  /** Resolved model definition for the adapter. */
  modelDef: import("../config/schema").ModelDef;
  /** Maximum session duration in seconds. */
  timeoutSeconds: number;
  /** Feature name for session naming and log correlation. */
  featureName?: string;
  /** Story ID for session naming and log correlation. */
  storyId?: string;
  /** Abort signal forwarded to the adapter. */
  signal?: AbortSignal;
  /** PID registration callback forwarded to the adapter. */
  onPidSpawned?: (pid: number) => void;
  /** PID unregistration callback forwarded to the adapter — pairs with onPidSpawned. */
  onPidExited?: (pid: number) => void;
  /** Eager protocol-id callback forwarded to the adapter. */
  onSessionEstablished?: (protocolIds: ProtocolIds, sessionName: string) => void;
}

/**
 * Options for SessionManager.sendPrompt().
 * The interactionHandler defaults to NO_OP when omitted.
 */
export interface SendPromptOpts {
  /** Mid-turn interaction callback (context-tool calls, agent questions). */
  interactionHandler?: import("../agents/interaction-handler").InteractionHandler;
  /** Abort signal — mid-turn abort transitions the handle to CANCELLED. */
  signal?: AbortSignal;
  /** Max interaction round-trips per turn (default: 10). */
  maxTurns?: number;
}

/**
 * Options shared by both runInSession overloads.
 */
export interface RunInSessionOpts extends OpenSessionRequest {
  /** Mid-turn interaction callback forwarded to sendPrompt. */
  interactionHandler?: import("../agents/interaction-handler").InteractionHandler;
  /** Max interaction round-trips per prompt. */
  maxTurns?: number;
}

/**
 * Input for SessionManager.nameFor() — produces an agent-agnostic session name.
 */
export interface NameForRequest {
  /** Working directory (hashed to produce the 8-char prefix). */
  workdir: string;
  /** Feature name (sanitised into the name). */
  featureName?: string;
  /** Story ID (sanitised into the name). */
  storyId?: string;
  /** Session role suffix. Preferred when available. */
  role?: SessionRole;
  /**
   * Pipeline stage used as the role suffix.
   * Used only when role is absent. "run" → no suffix.
   */
  pipelineStage?: import("../config/permissions").PipelineStage;
}

/** Interface the SessionManager implements */
export interface ISessionManager {
  /** Create a new session descriptor */
  create(options: CreateSessionOptions): SessionDescriptor;
  /** Get a session by ID (returns null if not found) */
  get(id: string): SessionDescriptor | null;
  /**
   * Transition a session to a new state.
   * Returns the updated descriptor.
   * Throws NaxError if the transition is invalid.
   */
  transition(id: string, to: SessionState, options?: TransitionOptions): SessionDescriptor;
  /**
   * Bind the protocol-specific session handle and IDs to a descriptor (Phase 1 plumbing).
   * Called by pipeline stages after agent.run() returns, using AgentResult.protocolIds.
   * Does not change the session's lifecycle state.
   * Returns the updated descriptor.
   * Throws NaxError if the session ID is unknown.
   */
  bindHandle(id: string, handle: string, protocolIds: ProtocolIds): SessionDescriptor;
  /**
   * Update the session owner agent during availability fallback.
   * Optional during the migration period; callers should guard with ?.handoff.
   */
  handoff?(id: string, newAgent: string, reason?: string): SessionDescriptor;
  /**
   * Look up an existing non-terminal session by storyId + role (Phase 3).
   * Returns the descriptor if found, null otherwise.
   * Used by rectification loops to resume the implementer session across attempts.
   */
  resume(storyId: string, role: SessionRole): SessionDescriptor | null;
  /**
   * Run a tracked session through a caller-provided run client.
   * Preserves the pre-ADR-019 bookkeeping behavior without importing AgentManager.
   */
  runInSession(
    id: string,
    runner: SessionRunClient,
    request: SessionManagedRunRequest,
    options?: SessionRunOptions,
  ): Promise<import("../agents/types").AgentResult>;

  /**
   * Force-close all non-terminal sessions for a story (Phase 3).
   * Transitions each matching session to COMPLETED regardless of current state.
   * Returns the descriptors of sessions that were closed.
   * Physical session close must be handled by the caller (via adapter.closePhysicalSession).
   */
  closeStory(storyId: string): SessionDescriptor[];
  /** List all active (non-terminal) sessions */
  listActive(): SessionDescriptor[];
  /**
   * Return all sessions for a given story ID.
   * Used by pipeline stages to collect scratch dirs from all story sessions.
   */
  getForStory(storyId: string): SessionDescriptor[];
  /** Remove completed/failed sessions older than ttlMs */
  sweepOrphans(ttlMs?: number): number;

  /**
   * Open (or resume) a named adapter-level session.
   * SessionManager resolves permissions from opts.pipelineStage before
   * forwarding to the adapter. Returns a SessionHandle for use with
   * sendPrompt / closeSession.
   *
   * Throws NaxError ADAPTER_NOT_FOUND if no adapter is configured.
   */
  openSession(name: string, opts: OpenSessionRequest): Promise<import("../agents/types").SessionHandle>;

  /**
   * Close an open session. Safe to call multiple times — the adapter call is
   * always attempted (errors are swallowed) and terminal-state descriptors are
   * not re-transitioned. The busy and cancelled flags for the handle are always
   * cleared regardless of adapter or descriptor state.
   */
  closeSession(handle: import("../agents/types").SessionHandle): Promise<void>;

  /**
   * Send one prompt to an open session. Single-flight per handle —
   * concurrent calls against the same handle throw NaxError SESSION_BUSY.
   * If the signal is aborted during the turn, the handle is marked CANCELLED
   * and subsequent sendPrompt calls against it throw NaxError SESSION_CANCELLED.
   */
  sendPrompt(
    handle: import("../agents/types").SessionHandle,
    prompt: string,
    opts?: SendPromptOpts,
  ): Promise<import("../agents/types").TurnResult>;

  /**
   * Convenience — open, send one prompt, close (try/finally).
   * Most ops use this via callOp.
   */
  runInSession(name: string, prompt: string, opts: RunInSessionOpts): Promise<import("../agents/types").TurnResult>;

  /**
   * Transactional multi-prompt form — open, run callback against live handle, close (try/finally).
   * Orchestrators that send 2+ prompts in one session use this.
   */
  runInSession<T>(
    name: string,
    runFn: (handle: import("../agents/types").SessionHandle) => Promise<T>,
    opts: RunInSessionOpts,
  ): Promise<T>;

  /**
   * Produce an agent-agnostic session name using the same hash-based formula
   * as the legacy computeAcpHandle, but owned by SessionManager.
   */
  nameFor(req: NameForRequest): string;

  /**
   * Look up a SessionDescriptor by session name (the handle string).
   * Returns null if no descriptor with that handle exists.
   */
  descriptor(name: string): SessionDescriptor | null;
}
