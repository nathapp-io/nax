/**
 * Aider Config Generator (v0.16.1)
 *
 * Generates .aider.conf.yml from nax/context.md + auto-injected metadata.
 */

import { formatMetadataSection } from "../injector";
import type { AgentContextGenerator, ContextContent } from "../types";

function generateAiderConfig(context: ContextContent): string {
  const header = `# Aider Configuration
# Auto-generated from nax/context.md — run \`nax generate\` to regenerate.
# DO NOT EDIT MANUALLY

# Project instructions
instructions: |
`;

  const metaSection = context.metadata ? formatMetadataSection(context.metadata) : "";
  const combined = metaSection + context.markdown;

  const indented = combined
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

  return `${header}${indented}\n`;
}

export const aiderGenerator: AgentContextGenerator = {
  name: "aider",
  outputFile: ".aider.conf.yml",
  generate: generateAiderConfig,
};
