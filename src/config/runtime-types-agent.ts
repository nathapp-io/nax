/**
 * Agent Protocol Configuration Type Definitions
 *
 * Agent-related configuration interfaces extracted from runtime-types.ts
 * to keep each file within the 600-line project limit.
 */

/** Generate command configuration */
export interface GenerateConfig {
  /**
   * Agents to generate config files for (default: all).
   * Restricts `nax generate` to only the listed agents.
   * @example ["claude", "opencode"]
   */
  agents?: Array<"claude" | "codex" | "opencode" | "cursor" | "windsurf" | "aider" | "gemini">;
}

/** Prompt audit configuration — opt-in file-based audit of all ACP-bound prompts. */
export interface PromptAuditConfig {
  /** When true, every prompt sent to ACP is written to a file for auditing. */
  enabled: boolean;
  /**
   * Directory to write audit files into.
   * Absolute path, or relative to workdir. Defaults to <workdir>/.nax/prompt-audit/ when absent.
   */
  dir?: string;
}

/** Agent fallback configuration */
export interface AgentFallbackConfig {
  /** Whether agent fallback is enabled (default: false) */
  enabled?: boolean;
  /**
   * Fallback map: agent name → ordered list of fallback targets, each either a
   * bare agent name or `{ agent, tier }` naming the tier the fallback should use.
   */
  map?: Record<string, (string | { agent: string; tier: string })[]>;
  /** Maximum fallback hops per story (default: 2, min 1, max 10) */
  maxHopsPerStory?: number;
  /** Whether to fall back on quality failure (default: false) */
  onQualityFailure?: boolean;
  /** Whether to rebuild context on fallback (default: true) */
  rebuildContext?: boolean;
}

/** Idle watchdog configuration */
export interface IdleWatchdogConfig {
  /** Whether the idle watchdog is enabled (default: true) */
  enabled?: boolean;
  /** Watchdog mode: off (disabled), observe (log only), warn-then-cancel (log + grace period + cancel), cancel (immediate) */
  mode?: "off" | "observe" | "warn-then-cancel" | "cancel";
  /** Idle timeout in seconds before watchdog triggers (default: 900) */
  idleTimeoutSeconds?: number;
  /** Max seconds a call may emit only tool-call activity before watchdog triggers (default: 1800, 0 disables this cap) */
  toolCallOnlyIdleTimeoutSeconds?: number;
  /** Activity kinds that reset the idle timer (default: all message, thinking, usage, and tool-call updates) */
  activityKinds?: Array<"message_update" | "thinking_update" | "usage_update" | "tool_call_update">;
  /** Grace period in seconds before cancel actually happens (used in warn-then-cancel mode, default: 10) */
  cancelGraceSeconds?: number;
  /** Maximum retry attempts before emitting terminal failure (default: 3) */
  maxRetryAttempts?: number;
}

/** ACP-specific agent configuration */
export interface AgentAcpConfig {
  /** Retries for transient prompt failures via acpx --prompt-retries (default: 0 — opt-in) */
  promptRetries?: number;
  /**
   * trackedSpawn hard deadline (ms) for teardown ops — sessions close/stop/cancel
   * (default: 10000). #1583.
   */
  trackedSpawnDeadlineMs?: number;
  /**
   * trackedSpawn hard deadline (ms) for startup ops — sessions ensure
   * (createSession/loadSession/applyReasoningEffort) (default: 30000). #1583.
   */
  trackedSpawnStartupDeadlineMs?: number;
}

/** Bounded same-agent retry after a wall-clock timeout (US-002) */
export interface AgentTimeoutRetryConfig {
  /** Maximum timeout-retry attempts (default: 1) */
  maxAttempts?: number;
  /** Fraction of the prior hop's timeoutSeconds granted to the retry (default: 0.5) */
  budgetMultiplier?: number;
}

/** Agent protocol configuration (ACP-003) */
export interface AgentConfig {
  /** Protocol to use for agent communication — a capability gate, not a router ('acp' | 'native' | 'hybrid', default 'acp') */
  protocol?: "acp" | "native" | "hybrid";
  /** Default agent name to use (default: 'claude') */
  default?: string;
  /** Max interaction turns when interactionBridge is active (default: 20) */
  maxInteractionTurns?: number;
  /** Prompt audit — write every ACP-bound prompt to a file for auditing. */
  promptAudit?: PromptAuditConfig;
  /** Agent fallback configuration */
  fallback?: AgentFallbackConfig;
  /** ACP-specific settings */
  acp?: AgentAcpConfig;
  /** Idle watchdog configuration */
  idleWatchdog?: IdleWatchdogConfig;
  /** Bounded same-agent retry after a wall-clock timeout */
  timeoutRetry?: AgentTimeoutRetryConfig;
}
