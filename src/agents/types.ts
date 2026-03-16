/**
 * Agent Adapter Interface
 *
 * Every coding agent (Claude Code, Codex, OpenCode, etc.)
 * implements this interface so nax can spawn, monitor, and
 * collect results from them uniformly.
 */

import type { NaxConfig } from "../config";
import type { ModelDef, ModelTier } from "../config/schema";
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
  /** ACP session name to resume for plan→run session continuity */
  acpSessionName?: string;
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
  /** Full nax config — passed through so adapters can call resolvePermissions() */
  config?: NaxConfig;
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
   * Full nax config — used by resolvePermissions() to determine permission mode.
   * Pass when available so complete() honours permissionProfile / dangerouslySkipPermissions.
   */
  config?: NaxConfig;
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
  plan(options: import("./shared/types-extended").PlanOptions): Promise<import("./shared/types-extended").PlanResult>;

  /** Run the agent in decompose mode to break spec into classified stories. */
  decompose(
    options: import("./shared/types-extended").DecomposeOptions,
  ): Promise<import("./shared/types-extended").DecomposeResult>;

  /**
   * Run a one-shot LLM call and return the plain text response.
   * Uses claude -p CLI for non-interactive completions.
   */
  complete(prompt: string, options?: CompleteOptions): Promise<string>;

  /**
   * Run the agent in interactive PTY mode for TUI embedding.
   * This method is optional — only implemented by agents that support
   * interactive terminal sessions (e.g., Claude Code).
   */
  runInteractive?(
    options: import("./shared/types-extended").InteractiveRunOptions,
  ): import("./shared/types-extended").PtyHandle;
}
