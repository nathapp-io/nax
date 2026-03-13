/**
 * Component test template builder
 *
 * Generates acceptance test structure for component testing strategy.
 * Supports ink-testing-library (lastFrame) and react (screen.getByText).
 */

import type { AcceptanceCriterion } from "../types";

export interface ComponentTemplateOptions {
  featureName: string;
  criteria: AcceptanceCriterion[];
  /** Test framework: 'ink-testing-library' | 'react' */
  testFramework?: string;
}

/**
 * Build component test template code for the given criteria.
 *
 * @param options - Feature name, criteria, and test framework
 * @returns TypeScript test code string
 */
export function buildComponentTemplate(options: ComponentTemplateOptions): string {
  const { featureName, criteria, testFramework = "ink-testing-library" } = options;

  if (testFramework === "react") {
    return buildReactTemplate(featureName, criteria);
  }

  return buildInkTemplate(featureName, criteria);
}

function buildInkTemplate(featureName: string, criteria: AcceptanceCriterion[]): string {
  const tests = criteria
    .map(
      (ac) => `  test("${ac.id}: ${ac.text}", () => {
    const { lastFrame } = render(<${toPascalCase(featureName)} />);
    expect(lastFrame()).toContain(""); // Replace with expected output
  });`,
    )
    .join("\n\n");

  return `import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ${toPascalCase(featureName)} } from "../src/${featureName}";

describe("${featureName} - Acceptance Tests", () => {
${tests}
});
`;
}

function buildReactTemplate(featureName: string, criteria: AcceptanceCriterion[]): string {
  const tests = criteria
    .map(
      (ac) => `  test("${ac.id}: ${ac.text}", () => {
    render(<${toPascalCase(featureName)} />);
    expect(screen.getByText("")).toBeTruthy(); // Replace with expected text
  });`,
    )
    .join("\n\n");

  return `import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ${toPascalCase(featureName)} } from "../src/${featureName}";

describe("${featureName} - Acceptance Tests", () => {
${tests}
});
`;
}

function toPascalCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
