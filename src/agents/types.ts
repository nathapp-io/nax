/**
 * Agent Adapter Interface
 *
 * Every coding agent (Claude Code, Codex, OpenCode, etc.)
 * implements this interface so ngent can spawn, monitor, and
 * collect results from them uniformly.
 */

import type { ModelTier, ModelDef } from "../config/schema";

/**
 * Agent execution result returned after running a coding agent.
 *
 * Contains success status, output, timing, and cost tracking.
 *
 * @example
 * ```ts
 * const result: AgentResult = {
 *   success: true,
 *   exitCode: 0,
 *   output: "Tests added to src/utils.test.ts",
 *   rateLimited: false,
 *   durationMs: 45000,
 *   estimatedCost: 0.0234,
 * };
 * ```
 */
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

/**
 * Configuration options for running a coding agent session.
 *
 * Includes prompt, working directory, model selection, timeout, and environment.
 *
 * @example
 * ```ts
 * const options: AgentRunOptions = {
 *   prompt: "Add unit tests for authentication module",
 *   workdir: "/home/user/project",
 *   modelTier: "balanced",
 *   modelDef: {
 *     model: "claude-sonnet-4.5",
 *     env: { ANTHROPIC_API_KEY: "sk-..." },
 *   },
 *   timeoutSeconds: 600,
 *   env: { DEBUG: "true" },
 * };
 * ```
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
}

/**
 * Agent adapter interface — one implementation per supported coding agent.
 *
 * Provides uniform interface for checking installation, running agents,
 * and building CLI commands across different coding agent tools.
 *
 * @example
 * ```ts
 * class MyAgentAdapter implements AgentAdapter {
 *   readonly name = "myagent";
 *   readonly displayName = "My Coding Agent";
 *   readonly binary = "myagent";
 *
 *   async isInstalled(): Promise<boolean> {
 *     // check if binary exists
 *   }
 *
 *   async run(options: AgentRunOptions): Promise<AgentResult> {
 *     // spawn process, capture output, calculate cost
 *   }
 *
 *   buildCommand(options: AgentRunOptions): string[] {
 *     return [this.binary, "--prompt", options.prompt];
 *   }
 * }
 * ```
 */
export interface AgentAdapter {
  /** Unique agent name (e.g., "claude", "codex", "opencode") */
  readonly name: string;

  /** Human-readable display name */
  readonly displayName: string;

  /** Binary command to check if agent is installed */
  readonly binary: string;

  /**
   * Check if the agent binary is available on this machine.
   *
   * @returns true if the agent is installed and available in PATH
   */
  isInstalled(): Promise<boolean>;

  /**
   * Run the agent with a prompt and return the result.
   *
   * @param options - Agent run configuration
   * @returns Execution result with success status, output, and cost
   */
  run(options: AgentRunOptions): Promise<AgentResult>;

  /**
   * Build the CLI command for a given run (for dry-run display).
   *
   * @param options - Agent run configuration
   * @returns Command array suitable for process spawning
   */
  buildCommand(options: AgentRunOptions): string[];
}
