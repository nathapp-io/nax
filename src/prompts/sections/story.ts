/**
 * Story Section
 *
 * Formats story title, description, and numbered acceptance criteria.
 */

import type { UserStory } from "../../prd/types";

export function buildStorySection(story: UserStory): string {
  const criteria = story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");

  return `# Story Context\n\n**Story:** ${story.title}\n\n**Description:**\n${story.description}\n\n**Acceptance Criteria:**\n${criteria}`;
}
