/**
 * Constitution CLI Command
 *
 * Generates agent-specific config files from nax/constitution.md.
 */

/** Constitution generate options */
export interface ConstitutionGenerateOptions {
  /** Path to constitution file (default: nax/constitution.md) */
  constitution?: string;
  /** Output directory (default: project root) */
  output?: string;
  /** Specific agent to generate for (default: all) */
  agent?: string;
  /** Dry run mode (don't write files) */
  dryRun?: boolean;
}
