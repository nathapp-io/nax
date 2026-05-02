/**
 * Acceptance Test Generator
 *
 * Parses spec.md acceptance criteria (AC-N lines) and generates configured acceptance tests
 * via LLM call to the agent adapter.
 */

import { AcceptancePromptBuilder } from "../prompts/builders/acceptance-builder";
import {
  acceptanceTestFilename as defaultAcceptanceTestFilename,
  resolveAcceptanceTestFile as defaultResolveAcceptanceTestFile,
} from "./test-path";
import type { AcceptanceCriterion } from "./types";

export { extractTestCode, generateSkeletonTests } from "./generator-helpers";

export const acceptanceTestFilename = defaultAcceptanceTestFilename;
export const resolveAcceptanceTestFile = defaultResolveAcceptanceTestFile;

/**
 * Build the command to run a single acceptance test file.
 *
 * Priority:
 * 1. `acceptance.command` override (with optional {{FILE}} placeholder)
 * 2. testFramework-aware single-file command (from QUALITY-002 profile)
 * 3. Fallback: `bun test <file> --timeout=60000`
 *
 * This is shared by both acceptance-setup (RED gate) and acceptance (post-run)
 * to ensure consistent behavior across both stages.
 */
export function buildAcceptanceRunCommand(
  testPath: string,
  testFramework?: string,
  commandOverride?: string,
): string[] {
  if (commandOverride) {
    // Support {{files}}, {{file}}, {{FILE}} — all resolve to the single acceptance test path
    const resolved = commandOverride
      .replace(/\{\{files\}\}/g, testPath)
      .replace(/\{\{file\}\}/g, testPath)
      .replace(/\{\{FILE\}\}/g, testPath);
    return resolved.trim().split(/\s+/);
  }

  switch (testFramework?.toLowerCase()) {
    case "vitest":
      return ["npx", "vitest", "run", testPath];
    case "jest":
      return ["npx", "jest", testPath];
    case "pytest":
      return ["pytest", testPath];
    case "go-test":
      return ["go", "test", testPath];
    case "cargo-test":
      return ["cargo", "test", "--test", "acceptance"];
    default:
      return ["bun", "test", testPath, "--timeout=60000"];
  }
}

export function parseAcceptanceCriteria(specContent: string): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [];
  const lines = specContent.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Match patterns:
    // - AC-1: description
    // - [ ] AC-1: description
    // AC-1: description
    const acMatch = line.match(/^\s*-?\s*(?:\[.\])?\s*(AC-\d+):\s*(.+)$/i);

    if (acMatch) {
      const id = acMatch[1].toUpperCase(); // Normalize to uppercase
      const text = acMatch[2].trim();

      criteria.push({
        id,
        text,
        lineNumber,
      });
    }
  }

  return criteria;
}

/**
 * Build LLM prompt for generating acceptance tests.
 *
 * Combines acceptance criteria, codebase context, and test generation instructions.
 *
 * @param criteria - Extracted acceptance criteria
 * @param featureName - Feature name for context
 * @param codebaseContext - File tree, dependencies, test patterns
 * @returns Formatted prompt string
 *
 * @example
 * ```ts
 * const prompt = buildAcceptanceTestPrompt(
 *   [{ id: "AC-1", text: "handles empty input", lineNumber: 5 }],
 *   "url-shortener",
 *   "File tree:\nsrc/\n  index.ts\n"
 * );
 * ```
 */
export function buildAcceptanceTestPrompt(
  criteria: AcceptanceCriterion[],
  featureName: string,
  _codebaseContext: string,
  testPathConfig?: string,
  language?: string,
): string {
  const criteriaList = criteria.map((ac) => `${ac.id}: ${ac.text}`).join("\n");
  const resolvedTestPath = resolveAcceptanceTestFile(language, testPathConfig);

  return new AcceptancePromptBuilder().buildGeneratorFromSpecPrompt({
    featureName,
    criteriaList,
    resolvedTestPath,
  });
}
