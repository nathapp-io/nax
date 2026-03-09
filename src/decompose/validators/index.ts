/**
 * Validator orchestrator.
 *
 * runAllValidators() runs all validators in sequence and returns merged ValidationResult.
 */

import type { UserStory } from "../../prd";
import type { DecomposeConfig, SubStory, ValidationResult } from "../types";
import type { ComplexityLevel } from "./complexity";
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
  const existingIds = existingStories.map((s) => s.id);
  const maxComplexity = (config.maxComplexity ?? "medium") as ComplexityLevel;

  const results = [
    validateOverlap(substories, existingStories),
    validateCoverage(originalStory, substories),
    validateComplexity(substories, maxComplexity),
    validateDependencies(substories, existingIds),
  ];

  const errors = results.flatMap((r) => r.errors);
  const warnings = results.flatMap((r) => r.warnings);

  return { valid: errors.length === 0, errors, warnings };
}
