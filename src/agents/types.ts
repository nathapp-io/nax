/**
 * Agent Adapter Interface
 *
 * Every coding agent (Claude Code, Codex, OpenCode, etc.)
 * implements this interface so ngent can spawn, monitor, and
 * collect results from them uniformly.
 */

/** Model tier for cost-based routing */
export type ModelTier = "cheap" | "standard" | "premium";

/** Agent execution result */
export interface AgentResult {
  /** Whether the agent completed successfully */
  success: boolean;
  /** Exit code from the process */
  exitCode: number;
  /** stdout output (last N lines) */
  output: string;
  /** Whether the agent hit a rate limit */
  rateLimited: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Estimated cost for this run (USD) */
  estimatedCost: number;
}

/** Agent session options */
export interface AgentRunOptions {
  /** The prompt to send to the agent */
  prompt: string;
  /** Working directory */
  workdir: string;
  /** Model tier to use */
  modelTier: ModelTier;
  /** Maximum runtime in seconds */
  timeoutSeconds: number;
  /** Environment variables to pass */
  env?: Record<string, string>;
}

/** Model mapping per tier for a specific agent */
export interface AgentModelMap {
  cheap: string;
  standard: string;
  premium: string;
}

/** Agent adapter — one per supported coding agent */
export interface AgentAdapter {
  /** Unique agent name (e.g., "claude", "codex", "opencode") */
  readonly name: string;

  /** Human-readable display name */
  readonly displayName: string;

  /** Binary command to check if agent is installed */
  readonly binary: string;

  /** Model mapping per tier */
  readonly models: AgentModelMap;

  /** Check if the agent binary is available on this machine */
  isInstalled(): Promise<boolean>;

  /** Run the agent with a prompt and return the result */
  run(options: AgentRunOptions): Promise<AgentResult>;

  /** Build the CLI command for a given run (for dry-run display) */
  buildCommand(options: AgentRunOptions): string[];
}
