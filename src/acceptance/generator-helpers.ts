/**
 * Acceptance generator helpers — skeleton test builders and code extraction.
 *
 * Extracted from generator.ts to keep each file within the 600-line project limit.
 */

import type { AcceptanceCriterion } from "./types";

function skeletonImportLine(testFramework?: string): string {
  if (!testFramework) return `import { describe, test, expect } from "bun:test";`;
  const fw = testFramework.toLowerCase();
  if (fw === "jest" || fw === "@jest/globals") {
    return `import { describe, test, expect } from "@jest/globals";`;
  }
  if (fw === "vitest") {
    return `import { describe, test, expect } from "vitest";`;
  }
  return `import { describe, test, expect } from "bun:test";`;
}

function generateGoSkeletonTests(_featureName: string, criteria: AcceptanceCriterion[]): string {
  const sanitize = (text: string) =>
    text
      .replace(/[^a-zA-Z0-9 ]/g, "")
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");

  const tests = criteria
    .map((ac) => {
      const funcName = `Test${sanitize(ac.text) || ac.id.replace("-", "")}`;
      return `func ${funcName}(t *testing.T) {\n\t// TODO: ${ac.id}: ${ac.text}\n\tt.Fatal("not implemented")\n}`;
    })
    .join("\n\n");

  return `package acceptance_test

import "testing"

${tests || "// No acceptance criteria found"}
`;
}

function generatePythonSkeletonTests(_featureName: string, criteria: AcceptanceCriterion[]): string {
  const sanitize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim()
      .replace(/\s+/g, "_");

  const tests = criteria
    .map((ac) => {
      const funcName = `test_${sanitize(ac.text) || ac.id.toLowerCase().replace("-", "_")}`;
      return `def ${funcName}():\n    # TODO: ${ac.id}: ${ac.text}\n    pytest.fail("not implemented")`;
    })
    .join("\n\n");

  return `import pytest

${tests || "# No acceptance criteria found"}
`;
}

function generateRustSkeletonTests(_featureName: string, criteria: AcceptanceCriterion[]): string {
  const sanitize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim()
      .replace(/\s+/g, "_");

  const tests = criteria
    .map((ac) => {
      const funcName = sanitize(ac.text) || ac.id.toLowerCase().replace("-", "_");
      return `    #[test]\n    fn ${funcName}() {\n        // TODO: ${ac.id}: ${ac.text}\n        panic!("not implemented");\n    }`;
    })
    .join("\n\n");

  return `#[cfg(test)]
mod tests {
${tests || "    // No acceptance criteria found"}
}
`;
}

/**
 * Generate skeleton acceptance tests with TODO placeholders.
 *
 * Used as fallback when LLM test generation fails.
 */
export function generateSkeletonTests(
  featureName: string,
  criteria: AcceptanceCriterion[],
  testFramework?: string,
  language?: string,
): string {
  const lang = language?.toLowerCase();

  if (lang === "go") {
    return generateGoSkeletonTests(featureName, criteria);
  }

  if (lang === "python") {
    return generatePythonSkeletonTests(featureName, criteria);
  }

  if (lang === "rust") {
    return generateRustSkeletonTests(featureName, criteria);
  }

  const tests = criteria
    .map((ac) => {
      return `  test("${ac.id}: ${ac.text}", async () => {
    // TODO: Implement acceptance test for ${ac.id}
    // ${ac.text}
    expect(true).toBe(false); // Replace with actual test
  });`;
    })
    .join("\n\n");

  return `${skeletonImportLine(testFramework)}

describe("${featureName} - Acceptance Tests", () => {
${tests || "  // No acceptance criteria found"}
});
`;
}

/**
 * Extract test code from agent output, supporting TypeScript, Go, Python, and Rust.
 *
 * Handles markdown code fences and extracts clean test code.
 */
export function extractTestCode(output: string): string | null {
  let code: string | undefined;

  const fenceMatch = output.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    code = fenceMatch[1].trim();
  }

  if (!code) {
    const goMatch = output.match(/package\s+\w+[\s\S]*?func\s+Test\w+\s*\(/);
    if (goMatch) {
      const startIdx = output.indexOf(goMatch[0]);
      code = output.slice(startIdx).trim();
    }
  }

  if (!code) {
    const pythonMatch = output.match(/(?:^|\n)((?:import\s+\w+[\s\S]*?)?def\s+test_\w+[\s\S]+)/);
    if (pythonMatch) {
      code = pythonMatch[1].trim();
    }
  }

  if (!code) {
    const importMatch = output.match(/import\s+{[\s\S]+/);
    if (importMatch) {
      code = importMatch[0].trim();
    }
  }

  if (!code) {
    const describeMatch = output.match(/describe\s*\([\s\S]+/);
    if (describeMatch) {
      code = describeMatch[0].trim();
    }
  }

  if (!code) return null;

  const hasTestKeyword =
    /\b(?:describe|test|it|expect)\s*\(/.test(code) ||
    /func\s+Test\w+\s*\(/.test(code) ||
    /def\s+test_\w+/.test(code) ||
    /#\[test\]/.test(code);

  if (!hasTestKeyword) {
    return null;
  }

  return code;
}
