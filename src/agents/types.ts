/**
 * Agent Adapter Interface
 *
 * Every coding agent (Claude Code, Codex, OpenCode, etc.)
 * implements this interface so nax can spawn, monitor, and
 * collect results from them uniformly.
 */

import type { NaxConfig } from "../config";
import type { ModelDef, ModelTier } from "../config/schema";
import type { AdapterFailure, ToolDescriptor } from "../context/engine";
import type { SessionDescriptor } from "../session/types";
import type { TokenUsage } from "./cost";

// Re-export extended types for backward compatibility
export type {
  PlanOptions,
  PlanResult,
  DecomposeOptions,
  DecomposeResult,
  DecomposedStory,
  PtyHandle,
  InteractiveRunOptions,
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
  /** Estimated cost for this run (USD) */
  estimatedCost: number;
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
  protocolIds?: {
    recordId: string | null;
    sessionId: string | null;
  };
  /**
   * Number of session-level retries (broken connection, QUEUE_DISCONNECTED).
   * Populated by the adapter; 0 when the first attempt succeeded.
   */
  sessionRetries?: number;
  /**
   * Structured failure classification (Phase 2 plumbing — additive, callers may ignore).
   * Populated on all non-success return paths. Undefined on success.
   *
   * Phase 5.5: pipeline stages will inspect this to call sessionManager.handoff() or
   * orchestrator.rebuildForAgent() instead of the adapter's internal fallback walk.
   * See: docs/specs/SPEC-session-manager-integration.md Gap 2.
   */
  adapterFailure?: AdapterFailure;
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
  /** Use --dangerously-skip-permissions flag (default: true) */
  dangerouslySkipPermissions?: boolean;
  /** Interaction bridge for mid-session human interaction (ACP) */
  interactionBridge?: {
    detectQuestion: (text: string) => Promise<boolean>;
    onQuestionDetected: (text: string) => Promise<string>;
  };
  /** PID registry for cleanup on crash/SIGTERM */
  pidRegistry?: import("../execution/pid-registry").PidRegistry;
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
  sessionRole?: string;
  /** Max turns in multi-turn interaction loop when interactionBridge is active (default: 10) */
  maxInteractionTurns?: number;
  /** Pipeline stage this run belongs to — used by resolvePermissions() (default: "run") */
  pipelineStage?: import("../config/permissions").PipelineStage;
  /** Full nax config — required so adapters can call resolvePermissions() and audit prompts */
  config: NaxConfig;
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
  /**
   * Session descriptor from SessionManager (Phase 1 plumbing — optional for backward compat).
   * When provided, the adapter MAY use descriptor.id/role/handle for audit correlation.
   * Phase 5.5: replaces sessionHandle, featureName, storyId, sessionRole, keepOpen.
   */
  session?: SessionDescriptor;
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
 * Options for one-shot LLM completion calls.
 */
export interface CompleteOptions {
  /** Maximum tokens for the response */
  maxTokens?: number;
  /** Request JSON-formatted output (adds --output-format json) */
  jsonMode?: boolean;
  /** Override the model (adds --model flag) */
  model?: string;
  /** Whether to skip permission prompts (maps to permissionMode in ACP) */
  dangerouslySkipPermissions?: boolean;
  /**
   * Working directory for the completion call.
   * Used by ACP adapter to set --cwd on the spawned acpx session.
   * CLI adapter uses this as the process cwd when spawning the agent binary.
   */
  workdir?: string;
  /**
   * Timeout for the completion call in milliseconds.
   * Adapters that support it (e.g. ACP) will enforce this as a hard deadline.
   * Callers may also wrap complete() in their own Promise.race for shorter timeouts.
   */
  timeoutMs?: number;
  /**
   * Full nax config — required so resolvePermissions() can determine permission mode
   * and prompt audit is always active when enabled.
   */
  config: NaxConfig;
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
  sessionRole?: string;
  /**
   * Model tier hint for adapters that resolve model from config (e.g. ACP adapter).
   * When set alongside `config`, the adapter resolves the model from `config.models[modelTier]`
   * instead of using the default. Has no effect when `model` is explicitly set.
   */
  modelTier?: ModelTier;
  /**
   * Pipeline stage label for prompt audit logs.
   * Defaults to "complete" when not provided.
   */
  pipelineStage?: import("../config/permissions").PipelineStage;
}

/**
 * Result for one-shot completion calls that include normalized cost metadata.
 */
export interface CompleteResult {
  /** Raw text output from the completion call */
  output: string;
  /** Cost for this completion call in USD */
  costUsd: number;
  /** How costUsd was derived */
  source: "exact" | "estimated" | "fallback";
  /** Set when complete() failed due to an availability error — consumed by completeWithFallback. */
  adapterFailure?: AdapterFailure;
}

/**
 * Typed error thrown when complete() fails due to non-zero exit or empty output.
 */
export class CompleteError extends Error {
  constructor(
    message: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = "CompleteError";
  }
}

/**
 * Parsed agent error information extracted from stderr.
 *
 * Identifies error types like rate limits, auth failures, timeouts, etc.
 */
export interface AgentError {
  /** Error type classification */
  type: "rate-limit" | "auth" | "timeout" | "crash" | "unknown";
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

  /** Run the agent with a prompt and return the result. */
  run(options: AgentRunOptions): Promise<AgentResult>;

  /** Build the CLI command for a given run (for dry-run display). */
  buildCommand(options: AgentRunOptions): string[];

  /** Run the agent in plan mode to generate a feature specification. */
  plan(options: import("./shared/types-extended").PlanOptions): Promise<import("./shared/types-extended").PlanResult>;

  /** Run the agent in decompose mode to break spec into classified stories. */
  decompose(
    options: import("./shared/types-extended").DecomposeOptions,
  ): Promise<import("./shared/types-extended").DecomposeResult>;

  /**
   * Run a one-shot LLM call and return output with cost metadata.
   * Uses claude -p CLI for non-interactive completions.
   */
  complete(prompt: string, options?: CompleteOptions): Promise<CompleteResult>;

  /**
   * Derive the protocol-specific session name for the given descriptor (Phase 1 plumbing).
   * Used by pipeline stages to obtain the handle string for sessionManager.bindHandle().
   *
   * ACP: "nax-<hash8>-<feature>-<storyId>-<role>" (same formula as computeAcpHandle)
   * CLI: not applicable — returns empty string.
   */
  deriveSessionName(descriptor: SessionDescriptor): string;

  /**
   * Close a physical agent session by its protocol-specific handle (Phase 3).
   * Called by pipeline stages via sessionManager.closeStory() or explicit close.
   * Best-effort — errors are swallowed.
   *
   * @param handle - The ACP session name (from descriptor.handle or deriveSessionName())
   * @param workdir - Working directory used when the session was created
   * @param options.force - When true, uses hard termination (acpx stop) after close (AC-83)
   */
  closePhysicalSession(handle: string, workdir: string, options?: { force?: boolean }): Promise<void>;

  /**
   * @deprecated Phase 3 (#477): use closePhysicalSession() instead.
   * Close a named session that was kept open with keepOpen: true.
   * Best-effort — errors are swallowed. No-op for adapters that do not support
   * named sessions (e.g. future non-ACP adapters).
   *
   * @param sessionName - The session name returned by computeAcpHandle()
   * @param workdir - Working directory used when the session was created
   */
  closeSession(sessionName: string, workdir: string): Promise<void>;

  /**
   * Run the agent in interactive PTY mode for TUI embedding.
   * This method is optional — only implemented by agents that support
   * interactive terminal sessions (e.g., Claude Code).
   */
  runInteractive?(
    options: import("./shared/types-extended").InteractiveRunOptions,
  ): import("./shared/types-extended").PtyHandle;
}
