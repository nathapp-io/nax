/**
 * Windsurf Rules Generator (v0.16.1)
 *
 * Generates .windsurfrules from .nax/context.md + auto-injected metadata.
 */

import { formatMetadataSection } from "../injector";
import type { AgentContextGenerator, ContextContent } from "../types";

function generateWindsurfRules(context: ContextContent): string {
  const header = `# Windsurf Project Rules

Auto-generated from .nax/context.md — run \`nax generate\` to regenerate.
DO NOT EDIT MANUALLY

---

`;

  const metaSection = context.metadata ? formatMetadataSection(context.metadata) : "";
  return header + metaSection + context.markdown;
}

export const windsurfGenerator: AgentContextGenerator = {
  name: "windsurf",
  outputFile: ".windsurfrules",
  generate: generateWindsurfRules,
};
