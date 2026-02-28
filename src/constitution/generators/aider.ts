/**
 * Aider Config Generator
 *
 * Generates .aider.conf.yml from nax/constitution.md.
 * Aider uses YAML format for configuration.
 */

import type { AgentConfigGenerator, ConstitutionContent } from "./types";

/**
 * Generate .aider.conf.yml from constitution
 */
function generateAiderConfig(constitution: ConstitutionContent): string {
  const { markdown } = constitution;

  // Build .aider.conf.yml format
  const header = `# Aider Configuration
# Auto-generated from nax/constitution.md
# DO NOT EDIT MANUALLY

# Project instructions
instructions: |
`;

  // Indent all lines of markdown for YAML multi-line string
  const indentedMarkdown = markdown
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  return `${header}${indentedMarkdown}\n`;
}

/**
 * Aider generator
 */
export const aiderGenerator: AgentConfigGenerator = {
  name: "aider",
  outputFile: ".aider.conf.yml",
  generate: generateAiderConfig,
};
