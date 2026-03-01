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
export type AgentType = "claude" | "opencode" | "cursor" | "windsurf" | "aider";

/** Generator registry map */
export type GeneratorMap = Record<AgentType, AgentContextGenerator>;
