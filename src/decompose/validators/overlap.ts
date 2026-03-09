/**
 * Overlap validator — stub.
 *
 * Checks keyword + AC similarity between each substory and all existing PRD stories.
 * Flags pairs with similarity > 0.6 as warnings, > 0.8 as errors.
 *
 * NOT YET IMPLEMENTED — stub returns no errors/warnings.
 */

import type { UserStory } from "../../prd";
import type { SubStory, ValidationResult } from "../types";

export function validateOverlap(substories: SubStory[], existingStories: UserStory[]): ValidationResult {
  void substories;
  void existingStories;
  return { valid: true, errors: [], warnings: [] };
}
