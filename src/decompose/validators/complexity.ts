/**
 * Complexity validator — stub.
 *
 * Validates each substory complexity is <= config.maxComplexity.
 * Reuses classifyComplexity() from src/routing/router.ts as cross-check.
 *
 * NOT YET IMPLEMENTED — stub returns no errors/warnings.
 */

import type { SubStory, ValidationResult } from "../types";

export type ComplexityLevel = "simple" | "medium" | "complex" | "expert";

export function validateComplexity(substories: SubStory[], maxComplexity: ComplexityLevel): ValidationResult {
  void substories;
  void maxComplexity;
  return { valid: true, errors: [], warnings: [] };
}
