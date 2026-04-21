/**
 * Session Manager Types
 *
 * Centralized session lifecycle for nax agent sessions.
 * Replaces the per-adapter sidecar pattern (Phase 5.5 migration target).
 *
 * See: docs/specs/SPEC-session-manager-integration.md
 */

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
// Session roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Purpose suffix that appears in the ACP session name.
 * "main" maps to no suffix (the default execution session).
 *
 * Registry: docs/architecture/adapter-wiring.md §2
 */
export type SessionRole =
  | "main" // Default implementation session (no suffix in name)
  | "test-writer" // TDD test-writing session
  | "implementer" // Rectification / autofix sessions
  | "verifier" // TDD verification session
  | "plan" // Planning stage
  | "decompose" // Story decomposition (complete())
  | "acceptance-gen" // Acceptance test generation (complete())
  | "refine" // AC criteria refinement (complete())
  | "fix-gen" // Fix story generation (complete())
  | "auto" // Auto-approve interaction (complete())
  | "diagnose" // Acceptance failure diagnosis (run())
  | "source-fix" // Acceptance source fix (run())
  | "reviewer-semantic" // Semantic review — keepOpen: true
  | "reviewer-adversarial"; // Adversarial review — keepOpen: true

// ─────────────────────────────────────────────────────────────────────────────
// Protocol IDs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Protocol-level IDs captured from the acpx adapter for audit correlation.
 *
 * recordId is stable — it identifies the logical ACP record across reconnects.
 * sessionId is volatile — it changes when the physical session is reconnected.
 *
 * Correlation chain:
 *   storyId → SessionDescriptor.id → protocolIds.recordId → prompt audit files
 */
export interface ProtocolIds {
  /** Stable acpx record ID — never changes for the lifetime of a logical session */
  recordId: string | null;
  /** Volatile acpx physical session ID — changes on reconnect */
  sessionId: string | null;
}

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
  /** Absolute path to the repo root where .nax/ lives — used by the audit writer to resolve the audit dir. */
  projectDir?: string;
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

/**
 * Minimal audit entry reported by adapters via the auditCallback hook.
 * SessionManager.auditPrompt() enriches this with stable session identity
 * (sess-<uuid>, agent, protocolIds) before writing to audit-writer.ts.
 */
export interface AuditTurnEntry {
  prompt: string;
  callType: "run" | "complete";
  pipelineStage: string;
  turn?: number;
  resumed?: boolean;
  /** Volatile ACP session name — used for filename and backward-compat header. */
  sessionName?: string;
  /** acpx record ID — stable across reconnects. */
  recordId?: string;
  /** acpx volatile session ID — changes on reconnect. */
  sessionId?: string;
}

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

/**
 * Options for SessionManager.runInSession (ADR-013 Phase 1).
 * Reserved for Phase 2 retry limits and abort signal overrides. Currently unused.
 */
// biome-ignore lint/complexity/noBannedTypes: reserved empty interface for Phase 2 extensions
export type SessionRunOptions = {};

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
   * Run an agent within a tracked session — the per-session lifecycle primitive.
   * (ADR-013 Phase 1: signature changed from SessionAgentRunner to IAgentManager.)
   *
   * Owns: CREATED→RUNNING transition before agentManager.run(), handle/protocolIds
   * binding from the result, and RUNNING→COMPLETED/FAILED transition after.
   * Callers don't need to touch transition/bindHandle for sessions that go
   * through this path.
   *
   * Every ISessionRunner implementation MUST use this for each session it
   * touches — that is how cross-cutting concerns (state transitions, token
   * pass-through, audit correlation) stay in one place instead of being
   * re-implemented per call site.
   *
   * Throws NaxError SESSION_NOT_FOUND if id is unknown. Propagates runner
   * errors verbatim AFTER transitioning the session to FAILED.
   */
  runInSession(
    id: string,
    agentManager: import("../agents/manager-types").IAgentManager,
    request: import("../agents/manager-types").AgentRunRequest,
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
   * Fire-and-forget audit write for a prompt turn. Enriches the raw entry with
   * the stable sess-<uuid>, current agent, and protocolIds from the descriptor,
   * then delegates to src/session/audit-writer.ts.
   *
   * No-op when the session is not found or audit is disabled in config.
   * Best-effort — errors are warned and swallowed.
   */
  auditPrompt(sessionId: string, entry: AuditTurnEntry, config: import("../config").NaxConfig): void;
}
