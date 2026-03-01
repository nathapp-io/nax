/**
 * Claude Code Config Generator (v0.16.1)
 *
 * Generates CLAUDE.md from nax/context.md + auto-injected metadata.
 */

import { formatMetadataSection } from "../injector";
import type { AgentContextGenerator, ContextContent } from "../types";

function generateClaudeConfig(context: ContextContent): string {
  const header = `# Project Context

This file is auto-generated from \`nax/context.md\`.
DO NOT EDIT MANUALLY — run \`nax generate\` to regenerate.

---

`;

  const metaSection = context.metadata ? formatMetadataSection(context.metadata) : "";
  return header + metaSection + context.markdown;
}

export const claudeGenerator: AgentContextGenerator = {
  name: "claude",
  outputFile: "CLAUDE.md",
  generate: generateClaudeConfig,
};
