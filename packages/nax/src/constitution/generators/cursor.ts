/**
 * Cursor Rules Generator
 *
 * Generates .cursorrules from .nax/constitution.md.
 * Cursor uses a simple text format similar to Claude but in a dotfile.
 */

import type { AgentConfigGenerator, ConstitutionContent } from "./types";

/**
 * Generate .cursorrules from constitution
 */
function generateCursorRules(constitution: ConstitutionContent): string {
  const { markdown } = constitution;

  // Build .cursorrules format
  const header = `# Project Rules

Auto-generated from .nax/constitution.md
DO NOT EDIT MANUALLY

---

`;

  return header + markdown;
}

/**
 * Cursor generator
 */
export const cursorGenerator: AgentConfigGenerator = {
  name: "cursor",
  outputFile: ".cursorrules",
  generate: generateCursorRules,
};
