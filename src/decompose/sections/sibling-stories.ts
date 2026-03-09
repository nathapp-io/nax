/**
 * Sibling stories section builder.
 *
 * Builds a prompt section with all other PRD stories (id, title, status, AC summary)
 * to help the LLM avoid overlap.
 */

import type { PRD, UserStory } from "../../prd";

export function buildSiblingStoriesSection(targetStory: UserStory, prd: PRD): string {
  const siblings = prd.userStories.filter((s) => s.id !== targetStory.id);

  if (siblings.length === 0) {
    return "# Sibling Stories\n\nNo other stories exist in this PRD.";
  }

  const entries = siblings
    .map((s) => {
      const acSummary = s.acceptanceCriteria.slice(0, 3).join("; ");
      return `- **${s.id}** — ${s.title} [${s.status}]\n  AC: ${acSummary}`;
    })
    .join("\n");

  return ["# Sibling Stories", "", "Avoid overlapping with these existing stories in the PRD:", "", entries].join("\n");
}
