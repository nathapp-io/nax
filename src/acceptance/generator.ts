/**
 * Acceptance Test Generator
 *
 * Parses spec.md acceptance criteria (AC-N lines) and generates configured acceptance tests
 * via LLM call to the agent adapter.
 */

import type { IAgentManager } from "../agents";
import { getLogger } from "../logger";
import { AcceptancePromptBuilder } from "../prompts/builders/acceptance-builder";
import { extractTestCode, generateSkeletonTests } from "./generator-helpers";
import {
  acceptanceTestFilename as defaultAcceptanceTestFilename,
  resolveAcceptanceTestFile as defaultResolveAcceptanceTestFile,
} from "./test-path";
import type { AcceptanceCriterion, AcceptanceTestResult, GenerateAcceptanceTestsOptions } from "./types";

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

/**
 * Generate acceptance tests from spec.md acceptance criteria.
 *
 * Parses AC lines from spec, builds LLM prompt, calls agent adapter,
 * and returns generated test code. Falls back to skeleton tests if LLM fails.
 *
 * @param adapter - Agent adapter to use for test generation
 * @param options - Generation options with spec content, context, and model
 * @returns Generated test code and processed criteria
 * @throws Error if AC parsing fails or agent call fails critically
 *
 * @example
 * ```ts
 * const adapter = new ClaudeCodeAdapter();
 * const result = await generateAcceptanceTests(adapter, {
 *   specContent: await Bun.file("spec.md").text(),
 *   featureName: "url-shortener",
 *   workdir: "/project",
 *   codebaseContext: "File tree:\nsrc/\n",
 *   modelTier: "balanced",
 *   modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
 * });
 *
 * await Bun.write(".nax-acceptance.test.ts", result.testCode);
 * ```
 */
export async function generateAcceptanceTests(
  agentManager: IAgentManager,
  options: GenerateAcceptanceTestsOptions,
): Promise<AcceptanceTestResult> {
  // Parse acceptance criteria from spec
  const logger = getLogger();
  const criteria = parseAcceptanceCriteria(options.specContent);

  if (criteria.length === 0) {
    // No AC found — generate empty skeleton
    logger.warn("acceptance", "⚠ No acceptance criteria found in spec.md");
    return {
      testCode: generateSkeletonTests(options.featureName, [], options.testFramework),
      criteria: [],
    };
  }

  logger.info("acceptance", "Found acceptance criteria", { count: criteria.length });

  // Build prompt
  const prompt = buildAcceptanceTestPrompt(
    criteria,
    options.featureName,
    options.codebaseContext,
    options.config?.acceptance?.testPath,
    options.config?.project?.language,
  );

  try {
    // Call adapter to generate tests
    const completeResult = await agentManager.complete(prompt, {
      model: options.modelDef.model,
      config: options.config,
      timeoutMs: options.config?.acceptance?.timeoutMs ?? 1800000,
      workdir: options.workdir,
      featureName: options.featureName,
      sessionRole: "acceptance-gen",
    });
    const output = typeof completeResult === "string" ? completeResult : completeResult.output;

    // Extract test code from output
    const testCode = extractTestCode(output);

    if (!testCode) {
      logger.warn("acceptance", "LLM returned non-code output for acceptance tests — falling back to skeleton", {
        outputPreview: output.slice(0, 200),
      });
      return {
        testCode: generateSkeletonTests(options.featureName, criteria, options.testFramework),
        criteria,
      };
    }

    return {
      testCode,
      criteria,
    };
  } catch (error) {
    logger.warn("acceptance", "⚠ Agent test generation error", { error: (error as Error).message });
    // Fall back to skeleton
    return {
      testCode: generateSkeletonTests(options.featureName, criteria, options.testFramework),
      criteria,
    };
  }
}
