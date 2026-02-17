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
 * Agent capability metadata describing what features and tiers the agent supports.
 *
 * Used for runtime validation and optimization — ensures the orchestrator only
 * routes tasks to agents that can actually handle them.
 *
 * @example
 * ```ts
 * const capabilities: AgentCapabilities = {
 *   supportedTiers: ["fast", "balanced", "powerful"],
 *   maxContextTokens: 200_000,
 *   features: new Set(["tdd", "review", "refactor", "batch"]),
 * };
 * ```
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
 * Configuration options for running an agent in plan mode.
 *
 * Plan mode spawns the agent interactively (or non-interactively with input file)
 * to gather requirements, ask clarifying questions, and produce a structured spec.
 *
 * @example
 * ```ts
 * const options: PlanOptions = {
 *   prompt: "Add URL shortener with analytics",
 *   workdir: "/home/user/project",
 *   interactive: true,
 *   codebaseContext: "File tree:\nsrc/\n  index.ts\n  utils.ts\n",
 * };
 * ```
 */
export interface PlanOptions {
  /** The initial planning prompt or task description */
  prompt: string;
  /** Working directory */
  workdir: string;
  /** Whether to run in interactive mode (agent takes over terminal) */
  interactive: boolean;
  /** Optional codebase context (file tree, dependencies, test patterns) */
  codebaseContext?: string;
  /** Optional input file path for non-interactive mode */
  inputFile?: string;
  /** Model tier to use for planning (default: "balanced") */
  modelTier?: ModelTier;
  /** Resolved model definition */
  modelDef?: ModelDef;
}

/**
 * Result from running an agent in plan mode.
 *
 * Contains the generated specification content and optional conversation log.
 *
 * @example
 * ```ts
 * const result: PlanResult = {
 *   specContent: "# Feature: URL Shortener\n\n## Problem\n...",
 *   conversationLog: "Agent: What storage backend should we use?\nUser: PostgreSQL\n...",
 * };
 * ```
 */
export interface PlanResult {
  /** The generated specification markdown content */
  specContent: string;
  /** Optional conversation log (for debugging/review) */
  conversationLog?: string;
}

/**
 * Configuration options for running an agent in decompose mode.
 *
 * Decompose mode reads a spec document and breaks it down into classified user stories
 * in a single LLM call (decompose + classify combined).
 *
 * @example
 * ```ts
 * const options: DecomposeOptions = {
 *   specContent: "# Feature: URL Shortener\n\n## Requirements...",
 *   workdir: "/home/user/project",
 *   codebaseContext: "File tree:\nsrc/\n  index.ts\n",
 *   modelTier: "balanced",
 * };
 * ```
 */
export interface DecomposeOptions {
  /** The spec document content to decompose */
  specContent: string;
  /** Working directory */
  workdir: string;
  /** Codebase context (file tree, dependencies, test patterns) */
  codebaseContext: string;
  /** Model tier to use for decomposition (default: "balanced") */
  modelTier?: ModelTier;
  /** Resolved model definition */
  modelDef?: ModelDef;
}

/**
 * A single classified user story from decompose result.
 */
export interface DecomposedStory {
  /** Story ID (e.g., "US-001") */
  id: string;
  /** Story title */
  title: string;
  /** Story description */
  description: string;
  /** Acceptance criteria */
  acceptanceCriteria: string[];
  /** Tags for routing */
  tags: string[];
  /** Dependencies (story IDs) */
  dependencies: string[];
  /** Classified complexity */
  complexity: "simple" | "medium" | "complex" | "expert";
  /** Relevant source files */
  relevantFiles: string[];
  /** Classification reasoning */
  reasoning: string;
  /** Estimated lines of code */
  estimatedLOC: number;
  /** Implementation risks */
  risks: string[];
}

/**
 * Result from running an agent in decompose mode.
 *
 * Contains the decomposed and classified user stories.
 *
 * @example
 * ```ts
 * const result: DecomposeResult = {
 *   stories: [
 *     {
 *       id: "US-001",
 *       title: "Add URL shortening endpoint",
 *       complexity: "medium",
 *       ...
 *     },
 *   ],
 * };
 * ```
 */
export interface DecomposeResult {
  /** The decomposed and classified user stories */
  stories: DecomposedStory[];
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
 *   readonly capabilities = {
 *     supportedTiers: ["fast", "balanced"],
 *     maxContextTokens: 100_000,
 *     features: new Set(["tdd", "review"]),
 *   };
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
 *
 *   async plan(options: PlanOptions): Promise<PlanResult> {
 *     // spawn agent in plan mode
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

  /** Capability metadata describing supported tiers and features */
  readonly capabilities: AgentCapabilities;

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

  /**
   * Run the agent in plan mode to generate a feature specification.
   *
   * Spawns the agent interactively or with an input file to gather requirements,
   * ask clarifying questions, and produce a structured spec document.
   *
   * @param options - Plan mode configuration
   * @returns Generated specification and optional conversation log
   */
  plan(options: PlanOptions): Promise<PlanResult>;

  /**
   * Run the agent in decompose mode to break spec into classified stories.
   *
   * Spawns the agent with spec content and codebase context to decompose
   * the specification into user stories and classify each story's complexity,
   * relevant files, risks, and estimated LOC in a single LLM call.
   *
   * @param options - Decompose mode configuration
   * @returns Decomposed and classified user stories
   */
  decompose(options: DecomposeOptions): Promise<DecomposeResult>;
}
