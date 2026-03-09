/**
 * Target story section builder.
 *
 * Builds a prompt section with full story details and decompose instruction.
 */

import type { UserStory } from "../../prd";

export function buildTargetStorySection(story: UserStory): string {
  const ac = story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const tags = story.tags.length > 0 ? story.tags.join(", ") : "none";
  const deps = story.dependencies.length > 0 ? story.dependencies.join(", ") : "none";

  return [
    "# Target Story to Decompose",
    "",
    `**ID:** ${story.id}`,
    `**Title:** ${story.title}`,
    "",
    "**Description:**",
    story.description,
    "",
    "**Acceptance Criteria:**",
    ac,
    "",
    `**Tags:** ${tags}`,
    `**Dependencies:** ${deps}`,
    "",
    "Decompose this story into smaller sub-stories that can each be implemented independently.",
  ].join("\n");
}
