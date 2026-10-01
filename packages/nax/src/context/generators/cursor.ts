/**
 * Cursor Rules Generator (v0.16.1)
 *
 * Generates .cursorrules from .nax/context.md + auto-injected metadata.
 */

import { formatMetadataSection } from "../injector";
import type { AgentContextGenerator, ContextContent } from "../types";

function generateCursorRules(context: ContextContent): string {
  const header = `# Project Rules

Auto-generated from .nax/context.md — run \`nax generate\` to regenerate.
DO NOT EDIT MANUALLY

---

`;

  const metaSection = context.metadata ? formatMetadataSection(context.metadata) : "";
  return header + metaSection + context.markdown;
}

export const cursorGenerator: AgentContextGenerator = {
  name: "cursor",
  outputFile: ".cursorrules",
  generate: generateCursorRules,
};
