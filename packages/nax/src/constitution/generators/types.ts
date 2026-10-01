/**
 * Constitution Generator Types
 *
 * Defines the interface for generating agent-specific config files from .nax/constitution.md.
 */

/** Constitution content structure for generators */
export interface ConstitutionContent {
  /** Full constitution markdown content */
  markdown: string;
  /** Parsed sections (optional, for structured generation) */
  sections?: Record<string, string>;
}

/** Agent config generator interface */
export interface AgentConfigGenerator {
  /** Generator name (e.g., 'claude', 'opencode', 'cursor') */
  name: string;
  /** Output filename (e.g., 'CLAUDE.md', '.cursorrules') */
  outputFile: string;
  /**
   * Generate agent-specific config file content from constitution
   * @param constitution - Constitution content
   * @returns Generated config file content
   */
  generate(constitution: ConstitutionContent): string;
}

/** All available generator types */
export type AgentType = "claude" | "opencode" | "cursor" | "windsurf" | "aider";

/** Generator registry map */
export type GeneratorMap = Record<AgentType, AgentConfigGenerator>;
