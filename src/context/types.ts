/**
 * Context Generator Types (v0.16.1)
 *
 * Types for generating agent config files from nax/context.md.
 * Replaces ConstitutionContent from the old constitution generator.
 */

/** Auto-injected project metadata */
export interface ProjectMetadata {
  /** Project name from manifest file */
  name?: string;
  /** Detected language/runtime (e.g. "TypeScript", "Go", "Rust", "Python") */
  language?: string;
  /** Key dependencies (framework, ORM, test runner, etc.) */
  dependencies: string[];
  /** Test command from nax config */
  testCommand?: string;
  /** Lint command from nax config */
  lintCommand?: string;
  /** Typecheck command from nax config */
  typecheckCommand?: string;
}

/** Context content passed to generators */
export interface ContextContent {
  /** Raw markdown from nax/context.md */
  markdown: string;
  /** Auto-injected project metadata (if enabled) */
  metadata?: ProjectMetadata;
}

/** Agent config generator interface */
export interface AgentContextGenerator {
  /** Generator name (e.g., 'claude', 'opencode', 'cursor') */
  name: string;
  /** Output filename (e.g., 'CLAUDE.md', '.cursorrules') */
  outputFile: string;
  /** Generate agent-specific config file content from context */
  generate(context: ContextContent): string;
}

/** All available generator types */
export type AgentType = "claude" | "codex" | "opencode" | "cursor" | "windsurf" | "aider";

/** Generator registry map */
export type GeneratorMap = Record<AgentType, AgentContextGenerator>;

/** A single context element (file content, error, story summary, etc.) */
export interface ContextElement {
  /** Element type identifier */
  type: string;
  /** Content text */
  content: string;
  /** Estimated token count */
  tokens: number;
  /** Priority (higher = selected first when budgeting) */
  priority: number;
  /** Story ID (for story/dependency elements) */
  storyId?: string;
  /** File path (for file elements) */
  filePath?: string;
  /** Human-readable label (optional) */
  label?: string;
}

/** Token budget for context building */
export interface ContextBudget {
  /** Total token limit */
  maxTokens: number;
  /** Tokens reserved for instructions/system prompt */
  reservedForInstructions: number;
  /** Tokens available for context elements */
  availableForContext: number;
}

/** Input to the context builder */
export interface StoryContext {
  /** PRD containing all stories */
  prd: import("../prd/types").PRD;
  /** ID of the current story being worked on */
  currentStoryId: string;
  /** Working directory for file scanning */
  workdir?: string;
  /** nax config (for context settings) */
  config?: import("../config").NaxConfig;
}

/** Output of the context builder */
export interface BuiltContext {
  /** Selected context elements (within budget) */
  elements: ContextElement[];
  /** Total tokens used */
  totalTokens: number;
  /** Whether some elements were truncated due to budget */
  truncated: boolean;
  /** Human-readable summary */
  summary: string;
}
