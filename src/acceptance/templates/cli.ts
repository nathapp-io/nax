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
export function buildCliTemplate(options: CliTemplateOptions): string {
  const { featureName, criteria } = options;

  const tests = criteria
    .map(
      (ac) => `  test("${ac.id}: ${ac.text}", async () => {
    const proc = Bun.spawn(["bun", "run", "src/${featureName}.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(""); // Replace with expected stdout text
  });`,
    )
    .join("\n\n");

  return `import { describe, expect, test } from "bun:test";

describe("${featureName} - Acceptance Tests", () => {
${tests}
});
`;
}
