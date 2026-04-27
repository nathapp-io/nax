/**
 * Tests for buildSourceFixPrompt content in executeSourceFix() — US-002 AC-7 / AC-8.
 *
 * Verifies that:
 * - When testFileContent is non-empty, the prompt includes it as a fenced TypeScript block
 * - When testFileContent is empty or undefined, the prompt includes only the acceptance test path
 */

import { describe, expect, test } from "bun:test";
import { executeSourceFix } from "../../../src/acceptance/fix-executor";
import type { DiagnosisResult } from "../../../src/acceptance/types";
import type { IAgentManager } from "../../../src/agents";
import { makeMockAgentManager, makeNaxConfig } from "../../../test/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let capturedPromptStore = "";

function makeAgentWithPromptCapture(result?: Partial<{ output: string }>): IAgentManager {
  return makeMockAgentManager({
    runFn: async (_agentName, opts) => {
      capturedPromptStore = opts.prompt;
      return {
        success: true,
        exitCode: 0,
        output: result?.output ?? "",
        rateLimited: false,
        durationMs: 500,
        estimatedCostUsd: 0.01,
        agentFallbacks: [],
      };
    },
  });
}

function makeDiagnosis(): DiagnosisResult {
  return { verdict: "source_bug", reasoning: "null pointer", confidence: 0.9 };
}

function getCapturedPrompt(): string {
  return capturedPromptStore;
}

const ACCEPTANCE_TEST_PATH = "/tmp/test/.nax/features/feat/.nax-acceptance.test.ts";

// ---------------------------------------------------------------------------
// US-002 AC-7: buildSourceFixPrompt includes test file content as fenced block
// ---------------------------------------------------------------------------

describe("AC-7 (US-002): buildSourceFixPrompt includes test file content as fenced TypeScript block", () => {
  test("prompt contains testFileContent in a fenced typescript block when non-empty", async () => {
    const agent = makeAgentWithPromptCapture();
    const testContent = `import { test, expect } from "bun:test";\ntest("AC-1: foo", () => { expect(foo()).toBe(1); });`;
    await executeSourceFix(agent, {
      testOutput: "FAIL: AC-1",
      testFileContent: testContent,
      diagnosis: makeDiagnosis(),
      config: makeNaxConfig(),
      workdir: "/tmp/test",
      featureName: "feat",
      storyId: "US-001",
      acceptanceTestPath: ACCEPTANCE_TEST_PATH,
    });
    const prompt = getCapturedPrompt();
    expect(prompt).toContain(testContent);
    expect(prompt).toContain("```typescript");
    expect(prompt).toContain("```");
  });

  test("prompt includes fenced block that contains the exact test file content", async () => {
    const agent = makeAgentWithPromptCapture();
    const testContent = `describe("suite", () => { test("AC-1: bar", () => { expect(bar()).toBe(2); }); });`;
    await executeSourceFix(agent, {
      testOutput: "FAIL",
      testFileContent: testContent,
      diagnosis: makeDiagnosis(),
      config: makeNaxConfig(),
      workdir: "/tmp/test",
      featureName: "feat",
      storyId: "US-001",
      acceptanceTestPath: ACCEPTANCE_TEST_PATH,
    });
    const prompt = getCapturedPrompt();
    // The fenced block should appear in the prompt body (not just as a path reference)
    const fencedBlock = `\`\`\`typescript\n${testContent}\n\`\`\``;
    expect(prompt).toContain(fencedBlock);
  });

  test("prompt still includes the acceptance test path alongside the fenced content", async () => {
    const agent = makeAgentWithPromptCapture();
    await executeSourceFix(agent, {
      testOutput: "FAIL",
      testFileContent: "import { test } from 'bun:test'; test('AC-1: x', () => {});",
      diagnosis: makeDiagnosis(),
      config: makeNaxConfig(),
      workdir: "/tmp/test",
      featureName: "feat",
      storyId: "US-001",
      acceptanceTestPath: ACCEPTANCE_TEST_PATH,
    });
    const prompt = getCapturedPrompt();
    expect(prompt).toContain(ACCEPTANCE_TEST_PATH);
    expect(prompt).toContain("```typescript");
  });
});

// ---------------------------------------------------------------------------
// US-002 AC-8: when testFileContent is empty or undefined, only path is included
// ---------------------------------------------------------------------------

describe("AC-8 (US-002): when testFileContent is empty/undefined, only path is included (current behavior)", () => {
  test("prompt contains only acceptance test path when testFileContent is empty string", async () => {
    const agent = makeAgentWithPromptCapture();
    await executeSourceFix(agent, {
      testOutput: "FAIL: AC-1",
      testFileContent: "",
      diagnosis: makeDiagnosis(),
      config: makeNaxConfig(),
      workdir: "/tmp/test",
      featureName: "feat",
      storyId: "US-001",
      acceptanceTestPath: ACCEPTANCE_TEST_PATH,
    });
    const prompt = getCapturedPrompt();
    expect(prompt).toContain(ACCEPTANCE_TEST_PATH);
    expect(prompt).not.toContain("```typescript");
  });

  test("prompt contains only acceptance test path when testFileContent is undefined", async () => {
    const agent = makeAgentWithPromptCapture();
    await executeSourceFix(agent, {
      testOutput: "FAIL: AC-1",
      testFileContent: undefined,
      diagnosis: makeDiagnosis(),
      config: makeNaxConfig(),
      workdir: "/tmp/test",
      featureName: "feat",
      storyId: "US-001",
      acceptanceTestPath: ACCEPTANCE_TEST_PATH,
    });
    const prompt = getCapturedPrompt();
    expect(prompt).toContain(ACCEPTANCE_TEST_PATH);
    expect(prompt).not.toContain("```typescript");
  });

  test("omitting testFileContent is accepted (field is optional)", async () => {
    const agent = makeAgentWithPromptCapture();
    // Should not throw when testFileContent is absent
    const result = await executeSourceFix(agent, {
      testOutput: "FAIL",
      diagnosis: makeDiagnosis(),
      config: makeNaxConfig(),
      workdir: "/tmp/test",
      featureName: "feat",
      storyId: "US-001",
      acceptanceTestPath: ACCEPTANCE_TEST_PATH,
    });
    expect(result).toBeDefined();
    expect(capturedPromptStore.length).toBeGreaterThan(0);
  });
});
