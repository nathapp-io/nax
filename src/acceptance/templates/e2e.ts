/**
 * E2E test template builder
 *
 * Generates acceptance test structure for end-to-end testing strategy.
 * Uses fetch() against localhost and asserts on response body.
 */

import type { AcceptanceCriterion } from "../types";

function buildTestImportLine(testFramework?: string): string {
  const fw = testFramework?.toLowerCase() ?? "";
  if (fw === "jest" || fw === "@jest/globals") return `import { describe, expect, test } from "@jest/globals";`;
  if (fw === "vitest") return `import { describe, expect, test } from "vitest";`;
  return `import { describe, expect, test } from "bun:test";`;
}

export interface E2eTemplateOptions {
  featureName: string;
  criteria: AcceptanceCriterion[];
  /** Optional test framework override (e.g. "jest", "vitest") */
  testFramework?: string;
}

const DEFAULT_PORT = 3000;

/**
 * Build E2E test template code for the given criteria.
 *
 * @param options - Feature name and criteria list
 * @returns TypeScript test code string
 */
export function buildE2eTemplate(options: E2eTemplateOptions): string {
  const { featureName, criteria, testFramework } = options;
  const importLine = buildTestImportLine(testFramework);

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

  return `${importLine}

describe("${featureName} - Acceptance Tests", () => {
${tests}
});
`;
}
