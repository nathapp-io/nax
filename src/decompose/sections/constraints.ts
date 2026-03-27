/**
 * Constraints section builder.
 *
 * Builds a prompt section with decomposition constraints:
 * max substories, max complexity, output JSON schema, nonOverlapJustification requirement.
 */

import type { DecomposeAgentConfig } from "../types";

export function buildConstraintsSection(config: DecomposeAgentConfig): string {
  return [
    "# Decomposition Constraints",
    "",
    `- **Max sub-stories:** ${config.maxSubStories}`,
    `- **Max complexity per sub-story:** ${config.maxComplexity}`,
    "",
    "Respond with ONLY a JSON array (no markdown code fences):",
    "[{",
    `  "id": "PARENT-ID-1",`,
    `  "parentStoryId": "PARENT-ID",`,
    `  "title": "Sub-story title",`,
    `  "description": "What to implement",`,
    `  "acceptanceCriteria": ["Criterion 1"],`,
    `  "tags": [],`,
    `  "dependencies": [],`,
    `  "complexity": "simple",`,
    `  "nonOverlapJustification": "Why this sub-story does not overlap with sibling stories"`,
    "}]",
    "",
    "The nonOverlapJustification field is required for every sub-story.",
  ].join("\n");
}
