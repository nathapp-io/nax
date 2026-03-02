/**
 * Agent Adapter Interface
 *
 * Every coding agent (Claude Code, Codex, OpenCode, etc.)
 * implements this interface so nax can spawn, monitor, and
 * collect results from them uniformly.
 */

import type { ModelDef, ModelTier } from "../config/schema";

// Re-export extended types for backward compatibility
export type {
  PlanOptions,
  PlanResult,
  DecomposeOptions,
  DecomposeResult,
  DecomposedStory,
  PtyHandle,
  InteractiveRunOptions,
} from "./types-extended";

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
  /** Process ID of the spawned agent (for cleanup on failure) */
  pid?: number;
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

  /** Run the agent with a prompt and return the result. */
  run(options: AgentRunOptions): Promise<AgentResult>;

  /** Build the CLI command for a given run (for dry-run display). */
  buildCommand(options: AgentRunOptions): string[];

  /** Run the agent in plan mode to generate a feature specification. */
  plan(options: import("./types-extended").PlanOptions): Promise<import("./types-extended").PlanResult>;

  /** Run the agent in decompose mode to break spec into classified stories. */
  decompose(options: import("./types-extended").DecomposeOptions): Promise<import("./types-extended").DecomposeResult>;

  /**
   * Run the agent in interactive PTY mode for TUI embedding.
   * This method is optional — only implemented by agents that support
   * interactive terminal sessions (e.g., Claude Code).
   */
  runInteractive?(options: import("./types-extended").InteractiveRunOptions): import("./types-extended").PtyHandle;
}
