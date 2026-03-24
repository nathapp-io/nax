/**
 * Snapshot test template builder
 *
 * Generates acceptance test structure for snapshot testing strategy.
 * Renders the component and uses toMatchSnapshot() for assertions.
 */

import type { AcceptanceCriterion } from "../types";

export interface SnapshotTemplateOptions {
  featureName: string;
  criteria: AcceptanceCriterion[];
  /** Test framework: 'ink-testing-library' | 'react' */
  testFramework?: string;
}

/**
 * Build snapshot test template code for the given criteria.
 *
 * @param options - Feature name, criteria, and optional test framework
 * @returns TypeScript test code string
 */
function buildTestImportLine(testFramework?: string): string {
  const fw = testFramework?.toLowerCase() ?? "";
  if (fw === "jest" || fw === "@jest/globals") return `import { describe, expect, test } from "@jest/globals";`;
  if (fw === "vitest") return `import { describe, expect, test } from "vitest";`;
  return `import { describe, expect, test } from "bun:test";`;
}

export function buildSnapshotTemplate(options: SnapshotTemplateOptions): string {
  const { featureName, criteria, testFramework } = options;
  const importLine = buildTestImportLine(testFramework);

  const tests = criteria
    .map(
      (ac) => `  test("${ac.id}: ${ac.text}", () => {
    const { lastFrame } = render(<${toPascalCase(featureName)} />);
    expect(lastFrame()).toMatchSnapshot();
  });`,
    )
    .join("\n\n");

  return `${importLine}
import { render } from "ink-testing-library";
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
