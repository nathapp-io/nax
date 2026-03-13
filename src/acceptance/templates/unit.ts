/**
 * Unit test template builder
 *
 * Generates acceptance test structure for unit testing strategy:
 * imports the function under test, calls it, and asserts on the return value.
 */

import type { AcceptanceCriterion } from "../types";

export interface UnitTemplateOptions {
  featureName: string;
  criteria: AcceptanceCriterion[];
}

/**
 * Build unit test template code for the given criteria.
 *
 * @param options - Feature name and criteria list
 * @returns TypeScript test code string
 */
export function buildUnitTemplate(options: UnitTemplateOptions): string {
  const { featureName, criteria } = options;

  const tests = criteria
    .map(
      (ac) => `  test("${ac.id}: ${ac.text}", async () => {
    // TODO: import and call the function under test
    expect(true).toBe(true); // Replace with real assertion
  });`,
    )
    .join("\n\n");

  return `import { describe, expect, test } from "bun:test";
import { ${toCamelCase(featureName)} } from "../src/${toKebabCase(featureName)}";

describe("${featureName} - Acceptance Tests", () => {
${tests}
});
`;
}

function toCamelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function toKebabCase(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}
