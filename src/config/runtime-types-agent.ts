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
  /** Fallback map: agent name → ordered list of fallback agent names */
  map?: Record<string, string[]>;
  /** Maximum fallback hops per story (default: 2, min 1, max 10) */
  maxHopsPerStory?: number;
  /** Whether to fall back on quality failure (default: false) */
  onQualityFailure?: boolean;
  /** Whether to rebuild context on fallback (default: true) */
  rebuildContext?: boolean;
}

/** ACP-specific agent configuration */
export interface AgentAcpConfig {
  /** Retries for transient prompt failures via acpx --prompt-retries (default: 0 — opt-in) */
  promptRetries?: number;
}

/** Agent protocol configuration (ACP-003) */
export interface AgentConfig {
  /** Protocol to use for agent communication (always 'acp') */
  protocol?: "acp";
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
}
