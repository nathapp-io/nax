/**
 * Claude Code Config Generator
 *
 * Generates CLAUDE.md from nax/constitution.md.
 */

import type { AgentConfigGenerator, ConstitutionContent } from "./types";

/**
 * Generate CLAUDE.md from constitution
 */
function generateClaudeConfig(constitution: ConstitutionContent): string {
  const { markdown } = constitution;

  // Build CLAUDE.md format
  const header = `# Project Constitution

This file is auto-generated from \`nax/constitution.md\`.
DO NOT EDIT MANUALLY — changes will be overwritten.

---

`;

  return header + markdown;
}

/**
 * Claude Code generator
 */
export const claudeGenerator: AgentConfigGenerator = {
  name: "claude",
  outputFile: "CLAUDE.md",
  generate: generateClaudeConfig,
};
