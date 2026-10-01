/**
 * Windsurf Rules Generator
 *
 * Generates .windsurfrules from .nax/constitution.md.
 * Windsurf uses a similar format to Cursor.
 */

import type { AgentConfigGenerator, ConstitutionContent } from "./types";

/**
 * Generate .windsurfrules from constitution
 */
function generateWindsurfRules(constitution: ConstitutionContent): string {
  const { markdown } = constitution;

  // Build .windsurfrules format
  const header = `# Windsurf Project Rules

Auto-generated from .nax/constitution.md
DO NOT EDIT MANUALLY

---

`;

  return header + markdown;
}

/**
 * Windsurf generator
 */
export const windsurfGenerator: AgentConfigGenerator = {
  name: "windsurf",
  outputFile: ".windsurfrules",
  generate: generateWindsurfRules,
};
