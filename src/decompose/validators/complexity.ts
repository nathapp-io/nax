/**
 * Complexity validator.
 *
 * Validates each substory complexity is <= config.maxSubstoryComplexity (default: medium).
 * Reuses classifyComplexity() from src/routing/router.ts as a cross-check against LLM-assigned complexity.
 */

import { classifyComplexity } from "../../routing";
import type { SubStory, ValidationResult } from "../types";

export type ComplexityLevel = "simple" | "medium" | "complex" | "expert";

const COMPLEXITY_ORDER: Record<ComplexityLevel, number> = {
  simple: 0,
  medium: 1,
  complex: 2,
  expert: 3,
};

export function validateComplexity(substories: SubStory[], maxComplexity: ComplexityLevel): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxOrder = COMPLEXITY_ORDER[maxComplexity];

  for (const sub of substories) {
    const assignedOrder = COMPLEXITY_ORDER[sub.complexity];

    if (assignedOrder > maxOrder) {
      errors.push(`Substory ${sub.id} complexity "${sub.complexity}" exceeds maxComplexity "${maxComplexity}"`);
    }

    // Cross-check with classifyComplexity
    const classified = classifyComplexity(sub.title, sub.description, sub.acceptanceCriteria, sub.tags);
    if (classified !== sub.complexity) {
      const classifiedOrder = COMPLEXITY_ORDER[classified as ComplexityLevel] ?? 0;
      if (classifiedOrder > assignedOrder) {
        warnings.push(
          `Substory ${sub.id} is assigned complexity "${sub.complexity}" but classifier estimates "${classified}" — may be underestimated`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
