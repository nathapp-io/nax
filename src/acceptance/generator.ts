/**
 * Acceptance Test Generator
 *
 * Parses spec.md acceptance criteria (AC-N lines) and generates configured acceptance tests
 * via LLM call to the agent adapter.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
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
 * Build the command to run a single acceptance test file as ONE shell command
 * string (US-001) — a string, not an argv array, because the override is
 * authored as a shell line (env assignments, `&&`, pipes, its own quoting).
 *
 * Priority:
 * 1. `acceptance.command` override (with optional {{FILE}} placeholder)
 * 2. testFramework-aware single-file command (from QUALITY-002 profile)
 * 3. Fallback: `bun test <file> --timeout=60000`
 *
 * This is shared by both acceptance-setup (RED gate) and acceptance (post-run)
 * to ensure consistent behavior across both stages.
 */
/** Resolve the pytest executable, preferring a local venv over the global PATH entry. */
function resolvePytestBin(packageDir?: string): string {
  if (packageDir) {
    for (const venvDir of [".venv", "venv", "env"]) {
      const candidate = join(packageDir, venvDir, "bin", "pytest");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "pytest";
}

/**
 * Substitute `{{files}}` / `{{file}}` / `{{FILE}}` in a command template with a
 * single resolved test path. Shared by `buildAcceptanceRunCommand` (per-argv-part,
 * for the actual exec) and `resolveAcceptanceFixTarget` (whole-string, for the
 * fix-role prompt) — one regex set so the placeholder dialect can't drift between
 * the two call sites.
 */
export function substituteAcceptanceTestPath(command: string, testPath: string): string {
  return command
    .replace(/\{\{files\}\}/g, testPath)
    .replace(/\{\{file\}\}/g, testPath)
    .replace(/\{\{FILE\}\}/g, testPath);
}

export function buildAcceptanceRunCommand(
  testPath: string,
  testFramework?: string,
  commandOverride?: string,
  packageDir?: string,
): string {
  // STUB (US-001): the pre-change argv build, space-joined without shell
  // quoting. The implementer replaces the two `join(" ")` calls with the
  // single shell string the ACs describe — trim the override and substitute
  // `shellQuoteArg(testPath)` for the placeholders, or quote-join the
  // framework default argv (US-001 AC1–AC8).
  if (commandOverride) {
    // Split on whitespace BEFORE substitution so a testPath containing spaces stays
    // a single argv element instead of being torn apart by the split below.
    // Support {{files}}, {{file}}, {{FILE}} — all resolve to the single acceptance test path.
    return commandOverride
      .trim()
      .split(/\s+/)
      .map((part) => substituteAcceptanceTestPath(part, testPath))
      .join(" ");
  }

  switch (testFramework?.toLowerCase()) {
    case "vitest":
      return ["npx", "vitest", "run", testPath].join(" ");
    case "jest":
      return ["npx", "jest", testPath].join(" ");
    case "pytest":
      return [resolvePytestBin(packageDir), testPath].join(" ");
    case "go-test":
      return ["go", "test", testPath].join(" ");
    case "cargo-test":
      return ["cargo", "test", "--test", "acceptance"].join(" ");
    default:
      return ["bun", "test", testPath, "--timeout=60000"].join(" ");
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
