/**
 * Dependency validator — stub.
 *
 * Validates:
 * - No circular dependencies among substories
 * - All referenced dependency IDs exist (in substories or existing PRD)
 * - No ID collisions with existing PRD story IDs
 *
 * NOT YET IMPLEMENTED — stub returns no errors/warnings.
 */

import type { SubStory, ValidationResult } from "../types";

export function validateDependencies(substories: SubStory[], existingStoryIds: string[]): ValidationResult {
  void substories;
  void existingStoryIds;
  return { valid: true, errors: [], warnings: [] };
}
