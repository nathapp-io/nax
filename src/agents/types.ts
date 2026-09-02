/**
 * Agent Adapter Interface
 *
 * Every coding agent (Claude Code, Codex, OpenCode, etc.)
 * implements this interface so nax can spawn, monitor, and
 * collect results from them uniformly.
 */

import type { AgentManagerConfig } from "@/config/selectors";
import type { ResolvedPermissions } from "../config/permissions";
import type { ModelDef, ModelTier } from "../config/schema";
import type { AdapterFailure, ToolDescriptor } from "../context/engine";
import type { ProtocolIds } from "../runtime/protocol-types";
import type { SessionRole } from "../runtime/session-role";
import type { TokenUsage } from "./cost";
import type {
  OpenSessionOpts,
  SendTurnOpts,
  SessionHandle,
  TrackedSpawnDeadlineOptions,
  TurnResult,
} from "./session-types";

// Session-protocol types live in ./session-types (file-size ratchet, #1702).
// Re-exported here so every existing "@/agents/types" import keeps working.
export type {
  InteractionExchange,
  OpenSessionOpts,
  SendTurnOpts,
  SessionHandle,
  TrackedSpawnDeadlineOptions,
  TurnResult,
} from "./session-types";
export { SessionTurnError } from "./session-types";
// Re-export extended types for backward compatibility
export type {
  DecomposedStory,
  DecomposeOptions,
  DecomposeResult,
} from "./shared/types-extended";

/**
 * Agent execution result returned after running a coding agent.
 */
export interface AgentResult {
  /** Whether the agent completed successfully */
  success: boolean;
  /** Exit code from the process */
  exitCode: number;
  /** stdout output (last N lines) */
  output: string;
  /** stderr output tail (last N lines) — useful for diagnosing failures */
  stderr?: string;
  /** Whether the agent hit a rate limit */
  rateLimited: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Estimated cost for this run (USD), computed from token usage × pricing rates. Always present. */
  estimatedCostUsd: number;
  /** Exact cost reported by the wire protocol (USD), when available. Independent of estimatedCostUsd. */
  exactCostUsd?: number;
  /** Token usage for this run (when available) */
  tokenUsage?: TokenUsage;
  /** Process ID of the spawned agent (for cleanup on failure) */
  pid?: number;
  /** Whether the failure was a session error (e.g. acpx exit code 4 — stale/locked session) */
  sessionError?: boolean;
  /** Whether acpx signalled the session error is retryable (e.g. QUEUE_DISCONNECTED_BEFORE_COMPLETION) */
  sessionErrorRetryable?: boolean;
  /**
   * Protocol-specific session identifiers from the agent backend (Phase 1 plumbing).
   * Populated by the adapter after ensureAcpSession() returns.
   * Pipeline stages pass these to sessionManager.bindHandle() for audit correlation.
   *
   * ACP: recordId is stable across reconnects; sessionId is volatile.
   */
  protocolIds?: ProtocolIds;
  /**
   * Structured failure classification (Phase 2 plumbing — additive, callers may ignore).
   * Populated on all non-success return paths. Undefined on success.
   *
   * Phase 5.5: pipeline stages will inspect this to call sessionManager.handoff() or
   * orchestrator.rebuildForAgent() instead of the adapter's internal fallback walk.
   * See: docs/specs/SPEC-session-manager-integration.md Gap 2.
   */
  adapterFailure?: AdapterFailure;
  /**
   * Agent swap records when AgentManager executed a cross-agent fallback
   * (ADR-013 Phase 1). Populated by IAgentManager.run(); empty array on success
   * with no swaps. Undefined when the result does not go through AgentManager.
   */
  agentFallbacks?: import("./manager-types").AgentFallbackRecord[];
  /**
   * Number of internal round-trips (session.prompt() calls) made by the adapter.
   * Populated by ACP adapter via TurnResult.internalRoundTrips when AgentResult
   * is derived from a session turn. Used by DispatchEvent.turn field.
   */
  internalRoundTrips?: number;
}

/**
 * Configuration options for running a coding agent session.
 */
export interface AgentRunOptions {
  /** The prompt to send to the agent */
  prompt: string;
  /** Working directory */
  workdir: string;
  /** Model tier (for cost estimation) */
  modelTier: ModelTier;
  /** Resolved model definition */
  modelDef: ModelDef;
  /** Maximum runtime in seconds */
  timeoutSeconds: number;
  /** Environment variables to pass */
  env?: Record<string, string>;
  /** Pre-resolved permissions from AgentManager — adapter reads this instead of calling resolvePermissions(). */
  resolvedPermissions?: ResolvedPermissions;
  /** Interaction bridge for mid-session human interaction (ACP) */
  interactionBridge?: {
    detectQuestion: (text: string) => Promise<boolean>;
    onQuestionDetected: (text: string) => Promise<string>;
  };
  /**
   * Explicit ACP session handle override. When set, the adapter uses this
   * name instead of auto-deriving from featureName/storyId/sessionRole.
   * Use only when a non-standard session name is required (e.g. generation-scoped
   * reviewer sessions in dialogue.ts). Most callers should omit this field.
   */
  sessionHandle?: string;
  /** Feature name for ACP session naming and logging */
  featureName?: string;
  /** Story ID for ACP session naming and logging */
  storyId?: string;
  /** Session role for TDD isolation (e.g. "test-writer" | "implementer" | "verifier") */
  sessionRole?: SessionRole;
  /** Max turns in multi-turn interaction loop when interactionBridge is active (default: 10) */
  maxInteractionTurns?: number;
  /** Pipeline stage this run belongs to — used by resolvePermissions() (default: "run") */
  pipelineStage?: import("../config/permissions").PipelineStage;
  /** Full nax config — required so adapters can call resolvePermissions() and audit prompts */
  config: AgentManagerConfig;
  /**
   * Absolute path to repo root where `.nax/` lives. When provided, prompt audit skips
   * the parent-directory walk and writes directly to `<projectDir>/.nax/prompt-audit/`.
   * Carries PipelineContext.projectDir.
   */
  projectDir?: string;
  /**
   * When true, the adapter will NOT close the session after a successful run.
   * Use for multi-attempt loops (rectification, review) where the same session
   * must persist across calls so the agent retains conversation context.
   * The caller is responsible for closing the session when the loop ends.
   */
  keepOpen?: boolean;
  /** Context-engine pull tools to expose for this run (ACP text-tool protocol). */
  contextPullTools?: ToolDescriptor[];
  /** Server-side runtime for resolving context-engine pull tool calls. */
  contextToolRuntime?: {
    callTool(name: string, input: unknown): Promise<string>;
  };
  /** Executes nax's own coding tools; absent means the op declared none. */
  codingToolRuntime?: import("@/tools").CodingToolRuntime;
  /**
   * Session descriptor from SessionManager (Phase 1 plumbing — optional for backward compat).
   * When provided, the adapter MAY use descriptor.id/role/handle for audit correlation.
   * Phase 5.5: replaces sessionHandle, featureName, storyId, sessionRole, keepOpen.
   */
  session?: {
    id: string;
    role: string;
    state: string;
    agent: string;
    workdir: string;
    featureName?: string;
    storyId?: string;
    protocolIds: ProtocolIds;
    handle?: string;
  };
  /**
   * Shutdown signal (fix for v0.63.0-canary.8 Issue 5).
   * When aborted, the adapter's retry loop must stop issuing new work:
   *   - no new session prompts
   *   - no new `closeAcpSession` spawns for "broken session retry"
   *   - return a clean failure result so the caller can unwind.
   * Owned by the crash-recovery signal handler; fires on SIGINT/SIGTERM/SIGHUP.
   * Optional for backward compat — adapters that ignore it stay functional.
   */
  abortSignal?: AbortSignal;
  /** Per-callOp invocation id stamped by the operation layer; forwarded to dispatch events. */
  readonly callId?: string;
  /** Caller-supplied region id forwarded from CallContext.scopeId; forwarded to dispatch events. */
  readonly scopeId?: string;
  /**
   * Fires once the agent has established its physical session and the
   * adapter has captured its protocol identifiers — before any prompt has
   * been sent (#591).
   *
   * Rationale: historically `protocolIds` were only reported back via the
   * final `AgentResult`. If the run was interrupted (SIGINT, crash,
   * first-turn failure) before return, the descriptor froze with
   * `NULL_PROTOCOL_IDS` and became un-resumable. This callback lets
   * `SessionManager.runInSession` bind the handle eagerly so the on-disk
   * descriptor captures `recordId`/`sessionId` as soon as they exist.
   *
   * Fired at most once per `run()` invocation. Adapters that do not know
   * their protocol ids ahead of the prompt can omit the call; the
   * `AgentResult.protocolIds` path still works as a fallback.
   *
   * Synchronous — the callback must not block the run loop. Implementations
   * that need async work should fire-and-forget.
   */
  onSessionEstablished?: (protocolIds: ProtocolIds, sessionName: string) => void;
}

/**
 * Agent capability metadata describing what features and tiers the agent supports.
 */
export interface AgentCapabilities {
  /** Model tiers this agent supports (e.g., fast/balanced/powerful) */
  readonly supportedTiers: readonly ModelTier[];
  /** Maximum context window size in tokens */
  readonly maxContextTokens: number;
  /** Feature flags — what workflows this agent can handle */
  readonly features: ReadonlySet<"tdd" | "review" | "refactor" | "batch">;
}

/**
 * Options for one-shot LLM completion calls. Callers pass this to
 * `AgentManager.completeAs()` — the manager fills in `resolvedPermissions`,
 * `promptRetries`, `onPidSpawned`, and `onPidExited` before handing the
 * augmented `ResolvedCompleteOptions` to the adapter.
 */
export interface CompleteOptions extends TrackedSpawnDeadlineOptions {
  /** Maximum tokens for the response */
  maxTokens?: number;
  /** Request JSON-formatted output (adds --output-format json) */
  jsonMode?: boolean;
  /**
   * Resolved model definition — the adapter uses modelDef.model directly to set
   * the --model flag on acpx. Set by callOp / completeAs callers before passing to the adapter.
   */
  modelDef: ModelDef;
  /**
   * Optional per-agent model resolver, consulted by `completeWithFallback` after
   * an agent swap (nax#1739). `modelDef` above is resolved for the PRIMARY agent
   * only; dispatching it verbatim to a fallback agent sends acpx a `--model` the
   * new agent never advertised, which the ACP agent rejects outright.
   *
   * The manager cannot re-resolve on its own — `agentManagerConfigSelector` picks
   * no `models` slice — so model policy stays at the `callOp` seam that already
   * owns it (ADR-019: the manager owns the swap loop, callOp owns model
   * resolution). Absent, or returning undefined, leaves `modelDef` in place.
   */
  /**
   * The model to dispatch for a given agent, and optionally at a given tier.
   * `tier` is supplied when a fallback target named one; absent means the
   * caller's own effective tier, which is what every pre-existing config does.
   */
  modelDefFor?: (agentName: string, tier?: string) => ModelDef | undefined;
  /**
   * Tier the model was resolved from, when it came from one. Absent when an
   * explicit `{ agent, model }` pin bypassed tier resolution. Recorded on cost
   * rows for attribution (#1433) — never branch on it.
   */
  modelTier?: ModelTier;
  /**
   * @internal Set by `AgentManager.completeAs`; callers must not pass this — it will be overwritten.
   * Pre-resolved permissions from AgentManager — adapter reads this instead of calling resolvePermissions().
   */
  resolvedPermissions?: ResolvedPermissions;
  /**
   * Working directory for the completion call.
   * Used by ACP adapter to set --cwd on the spawned acpx session.
   * CLI adapter uses this as the process cwd when spawning the agent binary.
   */
  workdir: string;
  /**
   * Timeout for the completion call in milliseconds.
   * Adapters that support it (e.g. ACP) will enforce this as a hard deadline.
   * Callers may also wrap complete() in their own Promise.race for shorter timeouts.
   */
  timeoutMs?: number;
  /**
   * Number of prompt retries for ACP sessions.
   * Pre-resolved by AgentManager.completeAs from config.agent.acp.promptRetries.
   */
  promptRetries?: number;
  /**
   * Named session to use for this completion call.
   * If omitted, a timestamp-based ephemeral session name is generated.
   * Pass a meaningful name (e.g. "nax-decompose-us-001") to aid debugging.
   */
  sessionName?: string;
  /** Feature name for ACP session naming — produces meaningful session IDs for debugging */
  featureName?: string;
  /** Story ID for ACP session naming — combined with featureName to form session key */
  storyId?: string;
  /** Session role for disambiguation when the same story has multiple concurrent sessions */
  sessionRole?: SessionRole;
  /** Abort signal for cancellation middleware support on complete() calls. */
  signal?: AbortSignal;
  /**
   * Pipeline stage label for prompt audit logs.
   * Defaults to "complete" when not provided.
   */
  pipelineStage?: import("../config/permissions").PipelineStage;
  config?: import("../config/selectors").AgentManagerConfig;
  /**
   * @internal Set by `AgentManager.completeAs`; callers must not pass this — it will be overwritten.
   * PID registration callback attached by AgentManager when a PidRegistry is configured.
   */
  onPidSpawned?: (pid: number) => void;
  /**
   * @internal Set by `AgentManager.completeAs`; callers must not pass this — it will be overwritten.
   * PID unregistration callback attached by AgentManager when a PidRegistry is configured.
   */
  onPidExited?: (pid: number) => void;
  /**
   * @internal Set by the wiring layer (AgentManager / SessionManager); callers must not pass this.
   * Generic per-call lifecycle hook — invoked by the adapter when a physical
   * agent invocation begins. The wiring layer uses this to register `cancel`
   * in any per-call cancellation registry it owns (e.g. the idle watchdog).
   * The adapter does not know what the consumer does with the cancel handle.
   */
  onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  /**
   * @internal Set by `AgentManager.completeAs`; callers must not pass this — it will be overwritten.
   * Stream activity callback forwarded from NaxRuntime.agentStreamEvents.
   * The adapter forwards prompt-level events (call_started, message_update, etc.)
   * onto this callback for the runtime bus.
   */
  onStreamActivity?: (event: import("../runtime/agent-stream-events").AgentStreamEvent) => void;
  /** Per-callOp invocation id stamped by the operation layer; forwarded to dispatch events. */
  readonly callId?: string;
  /** Caller-supplied region id forwarded from CallContext.scopeId; forwarded to dispatch events. */
  readonly scopeId?: string;
}

/**
 * `CompleteOptions` after `AgentManager.completeAs()` has filled in all
 * `@internal` fields. This is what the adapter boundary actually receives.
 * Only `manager.ts` and `completeWithFallback` should reference this type.
 */
export type ResolvedCompleteOptions = CompleteOptions & { resolvedPermissions: ResolvedPermissions };

/**
 * Result for one-shot completion calls that include normalized cost metadata.
 */
export interface CompleteResult {
  /** Raw text output from the completion call */
  output: string;
  /** Accumulated token usage for this completion call. */
  tokenUsage: TokenUsage;
  /** Estimated cost from token usage × pricing rates (always present). */
  estimatedCostUsd: number;
  /** Exact cost reported by wire protocol (when available). */
  exactCostUsd?: number;
  /** Set when complete() failed due to an availability error — consumed by completeWithFallback. */
  adapterFailure?: AdapterFailure;
  /**
   * Transport fact: `cancelActivePrompt()` was invoked during this call (i.e. an
   * external party, e.g. the idle watchdog, asked the adapter to cancel).
   * The adapter never classifies _why_ this happened — the wiring layer
   * (AgentManager / SessionManager) maps this to a policy outcome such as
   * `fail-stale` based on its own bookkeeping.
   */
  cancelled?: boolean;
}

/**
 * Typed error thrown when complete() fails due to non-zero exit or empty output.
 */
export class CompleteError extends Error {
  constructor(
    message: string,
    public readonly exitCode?: number,
    /** True/false when the transport (acpx) classified the failure as retryable; undefined when unknown. */
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "CompleteError";
  }
}

/**
 * Typed error thrown when openSession() or sendTurn() fails with a known AdapterFailure.
 * The manager catch block extracts the embedded adapterFailure so swap policy works correctly
 * for availability failures (e.g. quota exhausted, auth error).
 */
export class SessionFailureError extends Error {
  constructor(
    message: string,
    public readonly adapterFailure: AdapterFailure,
  ) {
    super(message);
    this.name = "SessionFailureError";
  }
}

/**
 * Parsed agent error information extracted from stderr.
 *
 * Identifies error types like rate limits, auth failures, timeouts, etc.
 */
export interface AgentError {
  /** Error type classification */
  type: "rate-limit" | "auth" | "timeout" | "crash" | "unknown" | "model-not-available";
  /** Optional retry delay in seconds (for rate-limit errors) */
  retryAfterSeconds?: number;
}

/**
 * Agent adapter interface — one implementation per supported coding agent.
 *
 * Provides uniform interface for checking installation, running agents,
 * and building CLI commands across different coding agent tools.
 */
export interface AgentAdapter {
  /** Unique agent name (e.g., "claude", "codex", "opencode") */
  readonly name: string;
  /** Human-readable display name */
  readonly displayName: string;
  /** Binary command to check if agent is installed */
  readonly binary: string;
  /** Capability metadata describing supported tiers and features */
  readonly capabilities: AgentCapabilities;

  /** Check if the agent binary is available on this machine. */
  isInstalled(): Promise<boolean>;

  /**
   * Probe whether the agent has usable credentials (env var, ping, etc.).
   * Optional — adapters that do not implement it are treated as always credentialed.
   * Used by AgentManager.validateCredentials() at run start.
   */
  hasCredentials?(): Promise<boolean>;

  /** Build the CLI command for a given run (for dry-run display). */
  buildCommand(options: AgentRunOptions): string[];

  /**
   * Run a one-shot LLM call and return output with cost metadata.
   * Uses claude -p CLI for non-interactive completions.
   */
  complete(prompt: string, options: ResolvedCompleteOptions): Promise<CompleteResult>;

  /**
   * Open a new (or resume an existing) physical agent session.
   * Returns an opaque SessionHandle carrying all state needed for subsequent
   * sendTurn() and closeSession() calls.
   */
  openSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle>;

  /**
   * Send one or more turns to an open session and return the accumulated result.
   * Handles context-tool and question interactions via opts.interactionHandler.
   */
  sendTurn(handle: SessionHandle, prompt: string, opts: SendTurnOpts): Promise<TurnResult>;

  /** Close the physical session and its underlying transport client. Best-effort — errors are swallowed. */
  closeSession(handle: SessionHandle): Promise<void>;

  /**
   * Close a session the process no longer holds a live handle for, addressing it by
   * id and workdir rather than by SessionHandle. Distinct from closeSession(): that
   * one closes an open in-process session, this one reconnects to the agent to close
   * a session left behind — the path run teardown takes
   * (src/execution/session-manager-runtime.ts).
   *
   * Optional because out-of-process teardown is not something every adapter can offer;
   * callers treat its absence as "nothing to close" and must invoke it best-effort.
   * Declared here rather than reached through a cast: it was undeclared until #1702,
   * so teardown had to assert its way to it and the two methods' handle types
   * (SessionHandle vs id string) disagreed invisibly.
   */
  closePhysicalSession?(
    handle: string,
    workdir: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<void>;
}
