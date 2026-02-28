/**
 * OpenCode Config Generator
 *
 * Generates AGENTS.md from nax/constitution.md.
 * Format is similar to CLAUDE.md but with OpenCode-specific headers.
 */

import type { AgentConfigGenerator, ConstitutionContent } from "./types";

/**
 * Generate AGENTS.md from constitution
 */
function generateOpencodeConfig(constitution: ConstitutionContent): string {
  const { markdown } = constitution;

  // Build AGENTS.md format (OpenCode/Codex format)
  const header = `# Agent Instructions

This file is auto-generated from \`nax/constitution.md\`.
DO NOT EDIT MANUALLY — changes will be overwritten.

These instructions apply to all AI coding agents in this project.

---

`;

  return header + markdown;
}

/**
 * OpenCode generator
 */
export const opencodeGenerator: AgentConfigGenerator = {
  name: "opencode",
  outputFile: "AGENTS.md",
  generate: generateOpencodeConfig,
};
