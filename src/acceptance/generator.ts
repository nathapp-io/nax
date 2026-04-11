/**
 * Acceptance Test Generator
 *
 * Parses spec.md acceptance criteria (AC-N lines) and generates configured acceptance tests
 * via LLM call to the agent adapter.
 */

import { join } from "node:path";
import { createAgentRegistry } from "../agents/registry";
import type { AgentAdapter } from "../agents/types";
import { getLogger } from "../logger";
import type { UserStory } from "../prd/types";
import { AcceptancePromptBuilder } from "../prompts/builders/acceptance-builder";
import {
  acceptanceTestFilename as defaultAcceptanceTestFilename,
  resolveAcceptanceTestFile as defaultResolveAcceptanceTestFile,
} from "./test-path";
import type {
  AcceptanceCriterion,
  AcceptanceTestResult,
  GenerateAcceptanceTestsOptions,
  GenerateFromPRDOptions,
  RefinedCriterion,
} from "./types";

/**
 * Build the test framework import line for skeleton/fallback tests.
 *
 * Returns the appropriate import statement based on the detected framework,
 * or defaults to `bun:test` when none is specified.
 */
function skeletonImportLine(testFramework?: string): string {
  if (!testFramework) return `import { describe, test, expect } from "bun:test";`;
  const fw = testFramework.toLowerCase();
  if (fw === "jest" || fw === "@jest/globals") {
    return `import { describe, test, expect } from "@jest/globals";`;
  }
  if (fw === "vitest") {
    return `import { describe, test, expect } from "vitest";`;
  }
  // For other frameworks (e.g. "@testing-library/react"), keep bun:test base
  return `import { describe, test, expect } from "bun:test";`;
}

/**
 * Parse acceptance criteria from spec.md content.
 *
 * Extracts lines matching "AC-N: description" or "- AC-N: description" patterns.
 *
 * @param specContent - Full spec.md markdown content
 * @returns Array of extracted acceptance criteria
 *
 * @example
 * ```ts
 * const spec = `
 * ## Acceptance Criteria
 * - AC-1: System should handle empty input
 * - AC-2: set(key, value, ttl) expires after ttl milliseconds
 * `;
 * const criteria = parseAcceptanceCriteria(spec);
 * // Returns: [
 * //   { id: "AC-1", text: "System should handle empty input", lineNumber: 3 },
 * //   { id: "AC-2", text: "set(key, value, ttl) expires after ttl", lineNumber: 4 },
 * // ]
 * ```
 */
/**
 * Injectable dependencies for generateFromPRD — allows tests to mock
 * adapter.complete() and file writes without real binaries or disk I/O.
 *
 * @internal
 */
export const _generatorPRDDeps = {
  adapter: {
    complete: async (...args: Parameters<AgentAdapter["complete"]>) => {
      const options = args[1];
      const config = options?.config;
      if (!config) throw new Error("Acceptance generator adapter requires config");

      const adapter = createAgentRegistry(config).getAgent(config.autoMode.defaultAgent);
      if (!adapter) throw new Error(`Agent "${config.autoMode.defaultAgent}" not found`);

      return adapter.complete(...args);
    },
  } satisfies Pick<AgentAdapter, "complete">,
  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
  },
  backupFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
  },
};

function hasLikelyTestContent(content: string): boolean {
  return (
    /\b(?:describe|test|it|expect)\s*\(/.test(content) ||
    /func\s+Test\w+\s*\(/.test(content) ||
    /def\s+test_\w+/.test(content) ||
    /#\[test\]/.test(content)
  );
}

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

/**
 * Generate acceptance tests from PRD UserStory[] and RefinedCriterion[].
 *
 * This is a stub — implementation is provided by the implementer session.
 *
 * @param stories - User stories from the PRD
 * @param refinedCriteria - Refined criteria produced by the refinement module
 * @param options - Generation options
 * @returns Generated test code and processed criteria
 */
export async function generateFromPRD(
  _stories: UserStory[],
  refinedCriteria: RefinedCriterion[],
  options: GenerateFromPRDOptions,
): Promise<AcceptanceTestResult> {
  const logger = getLogger();

  const criteria: AcceptanceCriterion[] = refinedCriteria.map((c, i) => ({
    id: `AC-${i + 1}`,
    text: c.refined,
    lineNumber: i + 1,
  }));

  if (
    refinedCriteria.length === 0 &&
    !(options.implementationContext && options.implementationContext.length > 0) &&
    !options.previousFailure
  ) {
    return { testCode: "", criteria: [] };
  }

  const criteriaList = refinedCriteria.map((c, i) => `AC-${i + 1}: ${c.refined}`).join("\n");

  const frameworkOverrideLine = options.testFramework
    ? `\n[FRAMEWORK OVERRIDE: Use ${options.testFramework} as the test framework regardless of what you detect.]`
    : "";

  const prompt = new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
    featureName: options.featureName,
    criteriaList,
    frameworkOverrideLine,
    targetTestFilePath:
      options.targetTestFile ??
      join(
        options.workdir,
        ".nax",
        "features",
        options.featureName,
        resolveAcceptanceTestFile(options.language, options.config?.acceptance?.testPath),
      ),
    implementationContext: options.implementationContext,
    previousFailure: options.previousFailure,
  });

  logger.info("acceptance", "Generating tests from PRD refined criteria", { count: refinedCriteria.length });

  const completeResult = await (options.adapter ?? _generatorPRDDeps.adapter).complete(prompt, {
    model: options.modelDef.model,
    config: options.config,
    timeoutMs: options.config?.acceptance?.timeoutMs ?? 1800000,
    workdir: options.workdir,
    featureName: options.featureName,
    sessionRole: "acceptance-gen",
  });
  const genCostUsd = typeof completeResult === "string" ? 0 : (completeResult.costUsd ?? 0);
  const rawOutput = typeof completeResult === "string" ? completeResult : completeResult.output;
  let testCode = extractTestCode(rawOutput);

  logger.debug("acceptance", "Received raw output from LLM", {
    hasCode: testCode !== null,
    outputLength: rawOutput.length,
    outputPreview: rawOutput.slice(0, 300),
  });

  // BUG-076: ACP adapters write files to disk directly and return a conversational
  // summary rather than raw code. If extractTestCode() fails on the response text,
  // check whether the adapter already wrote the file to the package-local feature directory.
  if (!testCode) {
    const targetPath =
      options.targetTestFile ??
      join(
        options.workdir,
        ".nax",
        "features",
        options.featureName,
        resolveAcceptanceTestFile(options.language, options.config?.acceptance?.testPath),
      );
    const backupPath = `${targetPath}.llm-recovery.bak`;
    let recoveryFailed = false;

    logger.debug("acceptance", "BUG-076 recovery: checking for agent-written file", {
      targetPath,
      backupPath,
      featureName: options.featureName,
      workdir: options.workdir,
    });

    try {
      const existing = await Bun.file(targetPath).text();
      const recovered = extractTestCode(existing);
      const likelyTestContent = hasLikelyTestContent(existing);

      logger.debug("acceptance", "BUG-076 recovery: file check result", {
        fileSize: existing.length,
        extractedCode: recovered !== null,
        likelyTestContent,
        filePreview: existing.slice(0, 300),
      });

      if (recovered) {
        logger.info("acceptance", "Acceptance test written directly by agent — using existing file", { targetPath });
        testCode = recovered;
      } else if (existing.trim().length > 0 && likelyTestContent) {
        let backupCreated = false;
        try {
          await _generatorPRDDeps.backupFile(backupPath, existing);
          backupCreated = true;
        } catch (backupError) {
          logger.warn("acceptance", "BUG-076: failed to create recovery backup; preserving file anyway", {
            targetPath,
            backupPath,
            backupError: backupError instanceof Error ? backupError.message : String(backupError),
          });
        }
        logger.warn("acceptance", "BUG-076: preserving agent-written file with backup (heuristic recovery)", {
          targetPath,
          backupPath,
          backupCreated,
          reason: "extractTestCode returned null",
        });
        testCode = existing;
      } else {
        // File exists but does not contain recognizable test code.
        if (existing.trim().length > 0) {
          try {
            await _generatorPRDDeps.backupFile(backupPath, existing);
          } catch (backupError) {
            logger.warn("acceptance", "BUG-076: failed to create fallback backup for unrecognized file", {
              targetPath,
              backupPath,
              backupError: backupError instanceof Error ? backupError.message : String(backupError),
            });
          }
        }
        recoveryFailed = true;
        logger.error(
          "acceptance",
          "BUG-076: agent-written file not recognized as test code — falling back to skeleton",
          {
            targetPath,
            backupPath,
            fileSize: existing.length,
            filePreview: existing.slice(0, 300),
          },
        );
      }
    } catch (error) {
      // File read failed — recovery not possible
      recoveryFailed = true;
      logger.debug("acceptance", "BUG-076 recovery: failed to read agent-written file, falling back to skeleton", {
        targetPath,
        backupPath,
        error: error instanceof Error ? error.message : String(error),
        rawOutputPreview: rawOutput.slice(0, 500),
      });
    }

    if (recoveryFailed) {
      logger.error(
        "acceptance",
        "BUG-076: LLM returned non-code output and recovery could not produce runnable tests — falling back to skeleton",
        {
          rawOutputPreview: rawOutput.slice(0, 500),
          targetPath,
          backupPath,
        },
      );
    }
  }

  if (!testCode) {
    logger.warn("acceptance", "LLM returned non-code output for acceptance tests — falling back to skeleton", {
      outputPreview: rawOutput.slice(0, 200),
    });
    const skeletonCriteria: AcceptanceCriterion[] = refinedCriteria.map((c, i) => ({
      id: `AC-${i + 1}`,
      text: c.refined,
      lineNumber: i + 1,
    }));
    return {
      testCode: generateSkeletonTests(options.featureName, skeletonCriteria, options.testFramework, options.language),
      criteria: skeletonCriteria,
      costUsd: genCostUsd,
    };
  }

  const refinedJsonContent = JSON.stringify(
    refinedCriteria.map((c, i) => ({
      acId: `AC-${i + 1}`,
      original: c.original,
      refined: c.refined,
      testable: c.testable,
      storyId: c.storyId,
    })),
    null,
    2,
  );

  await _generatorPRDDeps.writeFile(join(options.featureDir, "acceptance-refined.json"), refinedJsonContent);

  return { testCode, criteria, costUsd: genCostUsd };
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
  adapter: AgentAdapter,
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
    const completeResult = await adapter.complete(prompt, {
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

/**
 * Extract test code from agent output, supporting TypeScript, Go, Python, and Rust.
 *
 * Handles markdown code fences and extracts clean test code.
 *
 * @param output - Agent stdout
 * @returns Extracted test code
 */
export function extractTestCode(output: string): string | null {
  let code: string | undefined;

  // Try to extract from markdown code fence (any language tag)
  const fenceMatch = output.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    code = fenceMatch[1].trim();
  }

  // Go: package declaration followed by func Test
  if (!code) {
    const goMatch = output.match(/package\s+\w+[\s\S]*?func\s+Test\w+\s*\(/);
    if (goMatch) {
      const startIdx = output.indexOf(goMatch[0]);
      code = output.slice(startIdx).trim();
    }
  }

  // Python: def test_ function
  if (!code) {
    const pythonMatch = output.match(/(?:^|\n)((?:import\s+\w+[\s\S]*?)?def\s+test_\w+[\s\S]+)/);
    if (pythonMatch) {
      code = pythonMatch[1].trim();
    }
  }

  // TypeScript: import statement
  if (!code) {
    const importMatch = output.match(/import\s+{[\s\S]+/);
    if (importMatch) {
      code = importMatch[0].trim();
    }
  }

  // TypeScript: describe() block
  if (!code) {
    const describeMatch = output.match(/describe\s*\([\s\S]+/);
    if (describeMatch) {
      code = describeMatch[0].trim();
    }
  }

  if (!code) return null;

  // Validate: must contain at least one test-like keyword across all languages
  const hasTestKeyword =
    /\b(?:describe|test|it|expect)\s*\(/.test(code) || // TypeScript/JS
    /func\s+Test\w+\s*\(/.test(code) || // Go
    /def\s+test_\w+/.test(code) || // Python
    /#\[test\]/.test(code); // Rust

  if (!hasTestKeyword) {
    return null;
  }

  return code;
}

/**
 * Generate skeleton acceptance tests with TODO placeholders.
 *
 * Used as fallback when LLM test generation fails.
 *
 * @param featureName - Feature name
 * @param criteria - Acceptance criteria to generate skeletons for
 * @returns TypeScript test code with TODO placeholders
 *
 * @example
 * ```ts
 * const skeleton = generateSkeletonTests("auth", [
 *   { id: "AC-1", text: "login succeeds", lineNumber: 5 },
 * ]);
 * // Generates test with TODO comment
 * ```
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
