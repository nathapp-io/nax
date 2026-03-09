/**
 * Coverage validator — stub.
 *
 * Checks that the union of substory acceptance criteria covers
 * the original story's AC using keyword matching.
 * Warns on unmatched original criteria.
 *
 * NOT YET IMPLEMENTED — stub returns no errors/warnings.
 */

import type { UserStory } from "../../prd";
import type { SubStory, ValidationResult } from "../types";

export function validateCoverage(originalStory: UserStory, substories: SubStory[]): ValidationResult {
  void originalStory;
  void substories;
  return { valid: true, errors: [], warnings: [] };
}
