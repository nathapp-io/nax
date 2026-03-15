/**
 * Extended Agent Type Definitions
 *
 * Types for plan mode, decompose mode, and interactive PTY sessions.
 * Separated from core types to keep each file under 400 lines.
 */

import type { ModelDef, ModelTier, NaxConfig } from "../config/schema";

/**
 * Configuration options for running an agent in plan mode.
 *
 * Plan mode spawns the agent interactively (or non-interactively with input file)
 * to gather requirements, ask clarifying questions, and produce a structured spec.
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
  /** Global config — used to resolve models.balanced when modelDef is absent */
  config?: Partial<NaxConfig>;
  /**
   * Interaction bridge for mid-session human Q&A (ACP only).
   * If provided, the agent can pause and ask clarifying questions during planning.
   */
  interactionBridge?: {
    detectQuestion: (text: string) => Promise<boolean>;
    onQuestionDetected: (text: string) => Promise<string>;
  };
  /** Feature name for ACP session naming (plan→run continuity) */
  featureName?: string;
  /** Story ID for ACP session naming (plan→run continuity) */
  storyId?: string;
  /** Session role for TDD isolation (e.g. "test-writer" | "implementer" | "verifier") */
  sessionRole?: string;
  /** Timeout in seconds — inherited from config.execution.sessionTimeoutSeconds */
  timeoutSeconds?: number;
  /** Whether to skip permission prompts (maps to permissionMode in ACP) */
  dangerouslySkipPermissions?: boolean;
  /** Max interaction turns when interactionBridge is active (default: 10) */
  maxInteractionTurns?: number;
  /**
   * Callback invoked with the ACP session name after the session is created.
   * Used to persist the name to status.json for plan→run session continuity.
   */
  onAcpSessionCreated?: (sessionName: string) => Promise<void> | void;
  /** PID registry for tracking spawned agent processes — cleanup on crash/SIGTERM */
  pidRegistry?: import("../execution/pid-registry").PidRegistry;
}

/**
 * Result from running an agent in plan mode.
 *
 * Contains the generated specification content and optional conversation log.
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
  /** Global config — used to resolve models.balanced when modelDef is absent */
  config?: Partial<NaxConfig>;
}

/** A single classified user story from decompose result. */
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
  /** Context files to inject into agent prompt before execution */
  contextFiles: string[];
  /** Classification reasoning */
  reasoning: string;
  /** Estimated lines of code */
  estimatedLOC: number;
  /** Implementation risks */
  risks: string[];
  /** Test strategy recommendation from LLM */
  testStrategy?: "three-session-tdd" | "test-after";
}

/**
 * Result from running an agent in decompose mode.
 *
 * Contains the decomposed and classified user stories.
 */
export interface DecomposeResult {
  /** The decomposed and classified user stories */
  stories: DecomposedStory[];
}

/**
 * PTY handle interface for managing spawned PTY process.
 *
 * Provides methods to write input, resize terminal, and kill process.
 * Returned by runInteractive() for TUI integration.
 */
export interface PtyHandle {
  /** Write input to PTY stdin */
  write(data: string): void;
  /** Resize PTY terminal */
  resize(cols: number, rows: number): void;
  /** Kill PTY process */
  kill(): void;
  /** Process ID */
  pid: number;
}

/**
 * Configuration options for running an agent in interactive PTY mode.
 *
 * Extends AgentRunOptions with PTY-specific callbacks for output streaming
 * and exit handling. Used by TUI to embed agent sessions.
 */
export interface InteractiveRunOptions extends AgentRunOptions {
  /** Callback fired when PTY outputs data */
  onOutput: (data: Buffer) => void;
  /** Callback fired when PTY process exits */
  onExit: (code: number) => void;
}

// Re-import for the extends clause
import type { AgentRunOptions } from "./types";
