/**
 * Acceptance Test Generator
 *
 * Parses spec.md acceptance criteria (AC-N lines) and generates acceptance.test.ts
 * via LLM call to the agent adapter.
 */

import type {
  AcceptanceCriterion,
  GenerateAcceptanceTestsOptions,
  AcceptanceTestResult,
} from "./types";
import type { AgentAdapter } from "../agents/types";

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
  const criteriaList = criteria
    .map((ac) => `${ac.id}: ${ac.text}`)
    .join("\n");

  return `You are a test engineer. Generate acceptance tests for the "${featureName}" feature based on the acceptance criteria below.

CODEBASE CONTEXT:
${codebaseContext}

ACCEPTANCE CRITERIA:
${criteriaList}

Generate a complete acceptance.test.ts file using bun:test framework. Follow these rules:

1. **One test per AC**: Each acceptance criterion maps to exactly one test
2. **Test observable behavior only**: No implementation details, only user-facing behavior
3. **Independent tests**: No shared state between tests
4. **Integration-level**: Tests should be runnable without mocking (use real implementations)
5. **Clear test names**: Use format "AC-N: <description>" for test names
6. **Async where needed**: Use async/await for operations that may be asynchronous

Use this structure:

\`\`\`typescript
import { describe, test, expect } from "bun:test";

describe("${featureName} - Acceptance Tests", () => {
  test("AC-1: <description>", async () => {
    // Test implementation
  });

  test("AC-2: <description>", async () => {
    // Test implementation
  });
});
\`\`\`

**Important**:
- Import the feature code being tested
- Set up any necessary test fixtures
- Use expect() assertions to verify behavior
- Clean up resources if needed (close connections, delete temp files)

Respond with ONLY the TypeScript test code (no markdown code fences, no explanation).`;
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
  const criteria = parseAcceptanceCriteria(options.specContent);

  if (criteria.length === 0) {
    // No AC found — generate empty skeleton
    console.warn("⚠ No acceptance criteria found in spec.md");
    return {
      testCode: generateSkeletonTests(options.featureName, []),
      criteria: [],
    };
  }

  console.log(`Found ${criteria.length} acceptance criteria`);

  // Build prompt
  const prompt = buildAcceptanceTestPrompt(
    criteria,
    options.featureName,
    options.codebaseContext,
  );

  try {
    // Call agent to generate tests (using decompose as pattern)
    const cmd = [
      adapter.binary,
      "--model", options.modelDef.model,
      "--dangerously-skip-permissions",
      "-p", prompt,
    ];

    const proc = Bun.spawn(cmd, {
      cwd: options.workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...(options.modelDef.env || {}),
      },
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      console.warn(`⚠ Agent test generation failed: ${stderr}`);
      // Fall back to skeleton
      return {
        testCode: generateSkeletonTests(options.featureName, criteria),
        criteria,
      };
    }

    // Extract test code from output
    const testCode = extractTestCode(stdout);

    return {
      testCode,
      criteria,
    };
  } catch (error) {
    console.warn(`⚠ Agent test generation error: ${(error as Error).message}`);
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
function extractTestCode(output: string): string {
  // Try to extract from markdown code fence
  const fenceMatch = output.match(/```(?:typescript|ts)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // If no fence, try to find import statement and take everything from there
  const importMatch = output.match(/import\s+{[\s\S]+/);
  if (importMatch) {
    return importMatch[0].trim();
  }

  // Fall back to full output
  return output.trim();
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
): string {
  const tests = criteria.map((ac) => {
    return `  test("${ac.id}: ${ac.text}", async () => {
    // TODO: Implement acceptance test for ${ac.id}
    // ${ac.text}
    expect(true).toBe(false); // Replace with actual test
  });`;
  }).join("\n\n");

  return `import { describe, test, expect } from "bun:test";

describe("${featureName} - Acceptance Tests", () => {
${tests || "  // No acceptance criteria found"}
});
`;
}
