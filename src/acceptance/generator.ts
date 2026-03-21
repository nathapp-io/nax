/**
 * Acceptance Test Generator
 *
 * Parses spec.md acceptance criteria (AC-N lines) and generates acceptance.test.ts
 * via LLM call to the agent adapter.
 */

import { join } from "node:path";
import { ClaudeCodeAdapter } from "../agents/claude";
import type { AgentAdapter } from "../agents/types";
import { getLogger } from "../logger";
import type { UserStory } from "../prd/types";
import type {
  AcceptanceCriterion,
  AcceptanceTestResult,
  GenerateAcceptanceTestsOptions,
  GenerateFromPRDOptions,
  RefinedCriterion,
} from "./types";

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
  adapter: new ClaudeCodeAdapter() as AgentAdapter,
  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
  },
};

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

  if (refinedCriteria.length === 0) {
    return { testCode: "", criteria: [] };
  }

  const criteriaList = refinedCriteria.map((c, i) => `AC-${i + 1}: ${c.refined}`).join("\n");

  const frameworkOverrideLine = options.testFramework
    ? `\n[FRAMEWORK OVERRIDE: Use ${options.testFramework} as the test framework regardless of what you detect.]`
    : "";

  const basePrompt = `You are a senior test engineer. Your task is to generate a complete acceptance test file for the "${options.featureName}" feature.

## Step 1: Understand and Classify the Acceptance Criteria

Read each AC below and classify its verification type:
- **file-check**: Verify by reading source files (e.g. "no @nestjs/jwt imports", "file exists", "module registered", "uses registerAs pattern")
- **runtime-check**: Load and invoke code directly, assert on return values or behavior
- **integration-check**: Requires a running service (e.g. HTTP endpoint returns 200, 11th request returns 429, database query succeeds)

ACCEPTANCE CRITERIA:
${criteriaList}

## Step 2: Explore the Project

Before writing any tests, examine the project to understand:
1. **Language and test framework** — check dependency manifests (package.json, go.mod, Gemfile, pyproject.toml, Cargo.toml, build.gradle, etc.) to identify the language and test runner
2. **Existing test patterns** — read 1-2 existing test files to understand import style, describe/test/it conventions, and available helpers
3. **Project structure** — identify relevant source directories to determine correct import or load paths

${frameworkOverrideLine}

## Step 3: Generate the Acceptance Test File

Write the complete acceptance test file using the framework identified in Step 2.

Rules:
- **One test per AC**, named exactly "AC-N: <description>"
- **file-check ACs** → read source files using the language's standard file I/O, assert with string or regex checks. Do not start the application.
- **runtime-check ACs** → load or import the module directly and invoke it, assert on the return value or observable side effects
- **integration-check ACs** → use the language's HTTP client or existing test helpers; add a clear setup block (beforeAll/setup/TestMain/etc.) explaining what must be running
- **NEVER use placeholder assertions** — no always-passing or always-failing stubs, no TODO comments as the only content, no empty test bodies
- Every test MUST have real assertions that PASS when the feature is correctly implemented and FAIL when it is broken
- Output raw code only — no markdown fences, start directly with the language's import or package declaration
- **Path anchor (CRITICAL)**: This test file will be saved at \`<repo-root>/nax/features/${options.featureName}/acceptance.test.ts\` and will ALWAYS run from the repo root via \`bun test <absolute-path>\`. The repo root is exactly 3 \`../\` levels above \`__dirname\`: \`join(__dirname, '..', '..', '..')\`. Never use 4 or more \`../\` — that would escape the repo. For monorepo projects, navigate into packages from root (e.g. \`join(root, 'apps/api/src')\`).`;

  const prompt = basePrompt;

  logger.info("acceptance", "Generating tests from PRD refined criteria", { count: refinedCriteria.length });

  const rawOutput = await (options.adapter ?? _generatorPRDDeps.adapter).complete(prompt, {
    model: options.modelDef.model,
    config: options.config,
    timeoutMs: options.config?.acceptance?.timeoutMs ?? 1800000,
    workdir: options.workdir,
  });
  const testCode = extractTestCode(rawOutput);

  if (!testCode) {
    logger.warn("acceptance", "LLM returned non-code output for acceptance tests — falling back to skeleton", {
      outputPreview: rawOutput.slice(0, 200),
    });
    const skeletonCriteria: AcceptanceCriterion[] = refinedCriteria.map((c, i) => ({
      id: `AC-${i + 1}`,
      text: c.refined,
      lineNumber: i + 1,
    }));
    return { testCode: generateSkeletonTests(options.featureName, skeletonCriteria), criteria: skeletonCriteria };
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

  return { testCode, criteria };
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
  codebaseContext: string,
): string {
  const criteriaList = criteria.map((ac) => `${ac.id}: ${ac.text}`).join("\n");

  return `You are a senior test engineer. Your task is to generate a complete acceptance test file for the "${featureName}" feature.

## Step 1: Understand and Classify the Acceptance Criteria

Read each AC below and classify its verification type:
- **file-check**: Verify by reading source files (e.g. "no @nestjs/jwt imports", "file exists", "module registered", "uses registerAs pattern")
- **runtime-check**: Load and invoke code directly, assert on return values or behavior
- **integration-check**: Requires a running service (e.g. HTTP endpoint returns 200, 11th request returns 429, database query succeeds)

ACCEPTANCE CRITERIA:
${criteriaList}

## Step 2: Explore the Project

Before writing any tests, examine the project to understand:
1. **Language and test framework** — check dependency manifests (package.json, go.mod, Gemfile, pyproject.toml, Cargo.toml, build.gradle, etc.) to identify the language and test runner
2. **Existing test patterns** — read 1-2 existing test files to understand import style, describe/test/it conventions, and available helpers
3. **Project structure** — identify relevant source directories to determine correct import or load paths


## Step 3: Generate the Acceptance Test File

Write the complete acceptance test file using the framework identified in Step 2.

Rules:
- **One test per AC**, named exactly "AC-N: <description>"
- **file-check ACs** → read source files using the language's standard file I/O, assert with string or regex checks. Do not start the application.
- **runtime-check ACs** → load or import the module directly and invoke it, assert on the return value or observable side effects
- **integration-check ACs** → use the language's HTTP client or existing test helpers; add a clear setup block (beforeAll/setup/TestMain/etc.) explaining what must be running
- **NEVER use placeholder assertions** — no always-passing or always-failing stubs, no TODO comments as the only content, no empty test bodies
- Every test MUST have real assertions that PASS when the feature is correctly implemented and FAIL when it is broken
- Output raw code only — no markdown fences, start directly with the language's import or package declaration
- **Path anchor (CRITICAL)**: This test file will be saved at \`<repo-root>/nax/features/${featureName}/acceptance.test.ts\` and will ALWAYS run from the repo root via \`bun test <absolute-path>\`. The repo root is exactly 3 \`../\` levels above \`__dirname\`: \`join(__dirname, '..', '..', '..')\`. Never use 4 or more \`../\` — that would escape the repo. For monorepo projects, navigate into packages from root (e.g. \`join(root, 'apps/api/src')\`).`;
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
 * await Bun.write("acceptance.test.ts", result.testCode);
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
      testCode: generateSkeletonTests(options.featureName, []),
      criteria: [],
    };
  }

  logger.info("acceptance", "Found acceptance criteria", { count: criteria.length });

  // Build prompt
  const prompt = buildAcceptanceTestPrompt(criteria, options.featureName, options.codebaseContext);

  try {
    // Call adapter to generate tests
    const output = await adapter.complete(prompt, {
      model: options.modelDef.model,
      config: options.config,
      timeoutMs: options.config?.acceptance?.timeoutMs ?? 1800000,
      workdir: options.workdir,
    });

    // Extract test code from output
    const testCode = extractTestCode(output);

    if (!testCode) {
      logger.warn("acceptance", "LLM returned non-code output for acceptance tests — falling back to skeleton", {
        outputPreview: output.slice(0, 200),
      });
      return {
        testCode: generateSkeletonTests(options.featureName, criteria),
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
      testCode: generateSkeletonTests(options.featureName, criteria),
      criteria,
    };
  }
}

/**
 * Extract TypeScript test code from agent output.
 *
 * Handles markdown code fences and extracts clean test code.
 *
 * @param output - Agent stdout
 * @returns Extracted test code
 */
function extractTestCode(output: string): string | null {
  let code: string | undefined;

  // Try to extract from markdown code fence
  const fenceMatch = output.match(/```(?:typescript|ts)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    code = fenceMatch[1].trim();
  }

  // If no fence, try to find import statement and take everything from there
  if (!code) {
    const importMatch = output.match(/import\s+{[\s\S]+/);
    if (importMatch) {
      code = importMatch[0].trim();
    }
  }

  // If no fence and no import, try to find describe() block
  if (!code) {
    const describeMatch = output.match(/describe\s*\([\s\S]+/);
    if (describeMatch) {
      code = describeMatch[0].trim();
    }
  }

  if (!code) return null;

  // Validate: extracted code must contain at least one test-like keyword
  const hasTestKeyword = /\b(?:describe|test|it|expect)\s*\(/.test(code);
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
export function generateSkeletonTests(featureName: string, criteria: AcceptanceCriterion[]): string {
  const tests = criteria
    .map((ac) => {
      return `  test("${ac.id}: ${ac.text}", async () => {
    // TODO: Implement acceptance test for ${ac.id}
    // ${ac.text}
    expect(true).toBe(false); // Replace with actual test
  });`;
    })
    .join("\n\n");

  return `import { describe, test, expect } from "bun:test";

describe("${featureName} - Acceptance Tests", () => {
${tests || "  // No acceptance criteria found"}
});
`;
}
