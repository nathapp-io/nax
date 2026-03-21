/**
 * OpenCode Config Generator (v0.16.1)
 *
 * Generates AGENTS.md from .nax/context.md + auto-injected metadata.
 */

import { formatMetadataSection } from "../injector";
import type { AgentContextGenerator, ContextContent } from "../types";

function generateOpencodeConfig(context: ContextContent): string {
  const header = `# Agent Instructions

This file is auto-generated from \`.nax/context.md\`.
DO NOT EDIT MANUALLY — run \`nax generate\` to regenerate.

These instructions apply to all AI coding agents in this project.

---

`;

  const metaSection = context.metadata ? formatMetadataSection(context.metadata) : "";
  return header + metaSection + context.markdown;
}

export const opencodeGenerator: AgentContextGenerator = {
  name: "opencode",
  outputFile: "AGENTS.md",
  generate: generateOpencodeConfig,
};
