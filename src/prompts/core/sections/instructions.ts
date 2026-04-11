/**
 * Instructions Section
 *
 * Generic instruction block for one-shot prompts.
 * Used by OneShotPromptBuilder for router, decomposer, and auto-approver roles.
 */

import type { PromptSection } from "../types";

export function instructionsSection(text: string): PromptSection {
  return {
    id: "instructions",
    overridable: false,
    content: `# INSTRUCTIONS\n\n${text}`,
  };
}
