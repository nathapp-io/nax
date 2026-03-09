/**
 * Gemini CLI Config Generator (v0.16.1)
 *
 * Generates GEMINI.md from nax/context.md + auto-injected metadata.
 */

import { formatMetadataSection } from "../injector";
import type { AgentContextGenerator, ContextContent } from "../types";

function generateGeminiConfig(context: ContextContent): string {
  const header = `# Gemini CLI Context

This file is auto-generated from \`nax/context.md\`.
DO NOT EDIT MANUALLY — run \`nax generate\` to regenerate.

---

`;

  const metaSection = context.metadata ? formatMetadataSection(context.metadata) : "";
  return header + metaSection + context.markdown;
}

export const geminiGenerator: AgentContextGenerator = {
  name: "gemini",
  outputFile: "GEMINI.md",
  generate: generateGeminiConfig,
};
