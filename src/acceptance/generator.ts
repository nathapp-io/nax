/**
 * Acceptance Test Generator
 *
 * Parses spec.md acceptance criteria (AC-N lines) and generates configured acceptance tests
 * via LLM call to the agent adapter.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { AcceptancePromptBuilder } from "../prompts/builders/acceptance-builder";
import { shellQuoteArg } from "../verification/shell-quote";
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
  // US-001: every acceptance runner executes the same shell command string
  // through `/bin/sh -c`, so the override and the framework default are both
  // returned as ONE string — with shell-quoting applied where needed.
  if (commandOverride !== undefined && commandOverride !== null) {
    // An override is a shell line: env assignments, `&&`, pipes, the user's own
    // quoting all reach `sh` verbatim. Only the test path is untrusted, so we
    // single-quote it via shellQuoteArg at every placeholder occurrence.
    return substituteAcceptanceTestPath(commandOverride.trim(), shellQuoteArg(testPath));
  }

  // No override: take the framework default argv and quote-join it. The default
  // is a fully-trusted string (lives in config), so wrapping every argv word in
  // single quotes cannot change which program is exec'd — the resulting string
  // is byte-identical to what `sh -c` would have seen under the pre-change
  // argv layout.
  let defaultArgv: string[];
  switch (testFramework?.toLowerCase()) {
    case "vitest":
      defaultArgv = ["npx", "vitest", "run", testPath];
      break;
    case "jest":
      defaultArgv = ["npx", "jest", testPath];
      break;
    case "pytest":
      defaultArgv = [resolvePytestBin(packageDir), testPath];
      break;
    case "go-test":
      defaultArgv = ["go", "test", testPath];
      break;
    case "cargo-test":
      // US-001: the cargo default intentionally does NOT include the testPath —
      // `cargo test --test acceptance` runs the package's `acceptance` test
      // binary, which is discovered by name. Keeps the pre-change intent.
      defaultArgv = ["cargo", "test", "--test", "acceptance"];
      break;
    default:
      defaultArgv = ["bun", "test", testPath, "--timeout=60000"];
      break;
  }
  return defaultArgv.map(shellQuoteArg).join(" ");
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
