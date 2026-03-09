/**
 * Validator orchestrator — stub.
 *
 * runAllValidators() runs all validators in sequence and returns merged ValidationResult.
 *
 * NOT YET IMPLEMENTED — stub returns no errors/warnings.
 */

import type { UserStory } from "../../prd";
import type { DecomposeConfig, SubStory, ValidationResult } from "../types";
import { validateComplexity } from "./complexity";
import { validateCoverage } from "./coverage";
import { validateDependencies } from "./dependency";
import { validateOverlap } from "./overlap";

export function runAllValidators(
  originalStory: UserStory,
  substories: SubStory[],
  existingStories: UserStory[],
  config: DecomposeConfig,
): ValidationResult {
  void originalStory;
  void substories;
  void existingStories;
  void config;
  void validateOverlap;
  void validateCoverage;
  void validateComplexity;
  void validateDependencies;
  return { valid: true, errors: [], warnings: [] };
}
