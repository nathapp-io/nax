/**
 * E2E test template builder
 *
 * Generates acceptance test structure for end-to-end testing strategy.
 * Uses fetch() against localhost and asserts on response body.
 */

import type { AcceptanceCriterion } from "../types";

export interface E2eTemplateOptions {
  featureName: string;
  criteria: AcceptanceCriterion[];
}

const DEFAULT_PORT = 3000;

/**
 * Build E2E test template code for the given criteria.
 *
 * @param options - Feature name and criteria list
 * @returns TypeScript test code string
 */
export function buildE2eTemplate(options: E2eTemplateOptions): string {
  const { featureName, criteria } = options;

  const tests = criteria
    .map(
      (ac) => `  test("${ac.id}: ${ac.text}", async () => {
    const response = await fetch("http://localhost:${DEFAULT_PORT}/api/${featureName}");
    expect(response.ok).toBe(true);
    const body = await response.text();
    expect(body).toContain(""); // Replace with expected response body
  });`,
    )
    .join("\n\n");

  return `import { describe, expect, test } from "bun:test";

describe("${featureName} - Acceptance Tests", () => {
${tests}
});
`;
}
