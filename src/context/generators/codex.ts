/**
 * Codex Config Generator (v0.16.1)
 *
 * Generates codex.md from .nax/context.md + auto-injected metadata.
 */

import { formatMetadataSection } from "../injector";
import type { AgentContextGenerator, ContextContent } from "../types";

function generateCodexConfig(context: ContextContent): string {
  const header = `# Codex Instructions

This file is auto-generated from \`.nax/context.md\`.
DO NOT EDIT MANUALLY — run \`nax generate\` to regenerate.

---

`;

  const metaSection = context.metadata ? formatMetadataSection(context.metadata) : "";
  return header + metaSection + context.markdown;
}

export const codexGenerator: AgentContextGenerator = {
  name: "codex",
  outputFile: "codex.md",
  generate: generateCodexConfig,
};
