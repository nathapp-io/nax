/**
 * Sibling stories section builder.
 *
 * Builds a prompt section with all other PRD stories (id, title, status, AC summary)
 * to help the LLM avoid overlap.
 * NOT IMPLEMENTED — stub for test RED phase.
 */

import type { PRD, UserStory } from "../../prd";

export function buildSiblingStoriesSection(_targetStory: UserStory, _prd: PRD): string {
  throw new Error("Not implemented: buildSiblingStoriesSection");
}
