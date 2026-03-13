/**
 * CLI test template builder
 *
 * Generates acceptance test structure for CLI testing strategy.
 * Uses Bun.spawn to run the binary and asserts on stdout text.
 */

import type { AcceptanceCriterion } from "../types";

export interface CliTemplateOptions {
  featureName: string;
  criteria: AcceptanceCriterion[];
}

/**
 * Build CLI test template code for the given criteria.
 *
 * @param options - Feature name and criteria list
 * @returns TypeScript test code string
 */
export function buildCliTemplate(_options: CliTemplateOptions): string {
  // stub — implementer will provide real logic
  return "";
}
