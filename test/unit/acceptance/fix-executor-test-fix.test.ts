/**
 * Tests for executeTestFix() and buildTestFixPrompt() in src/acceptance/fix-executor.ts
 */

import { describe, expect, test } from "bun:test";
import { type ExecuteTestFixOptions, executeTestFix } from "../../../src/acceptance/fix-executor";
import type { DiagnosisResult } from "../../../src/acceptance/types";
import type { IAgentManager } from "../../../src/agents";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config/schema";
import { AcceptancePromptBuilder } from "../../../src/prompts";
import { makeMockAgentManager } from "../../../test/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentManager(result?: Partial<{ success: boolean; estimatedCostUsd: number }>): IAgentManager {
  return makeMockAgentManager({
    runFn: async () => ({
      success: result?.success ?? true,
      exitCode: 0,
      output: "console.log('fix applied');",
      rateLimited: false,
      durationMs: 1000,
      estimatedCostUsd: result?.estimatedCostUsd ?? 0.05,
      agentFallbacks: [],
    }),
  });
}

function makeMinimalConfig(overrides: Partial<NaxConfig["acceptance"]> = {}): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    models: {
      claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
    },
    autoMode: { ...DEFAULT_CONFIG.autoMode },
    routing: { ...DEFAULT_CONFIG.routing },
    execution: { ...DEFAULT_CONFIG.execution },
    quality: { ...DEFAULT_CONFIG.quality },
    tdd: { ...DEFAULT_CONFIG.tdd },
    constitution: { ...DEFAULT_CONFIG.constitution },
    review: { ...DEFAULT_CONFIG.review },
    plan: { ...DEFAULT_CONFIG.plan },
    acceptance: {
      ...DEFAULT_CONFIG.acceptance,
      ...overrides,
    },
    context: { ...DEFAULT_CONFIG.context },
    agent: { protocol: "acp", default: "claude" },
  } as NaxConfig;
}

function makeDiagnosis(
  reasoning = "null pointer in add()",
  verdict: DiagnosisResult["verdict"] = "source_bug",
): DiagnosisResult {
  return {
    verdict,
    reasoning,
    confidence: 0.9,
  };
}

function makeTestFixOptions(overrides: Partial<ExecuteTestFixOptions> = {}): ExecuteTestFixOptions {
  return {
    testOutput: "(fail) AC-6: stdout indentation\n  expected '  \"id\"' got '  {'",
    testFileContent:
      'import { test, expect } from "bun:test";\ntest("AC-6", () => { expect(lines[1]).toMatch(/^  "id"/); });',
    failedACs: ["AC-6", "AC-7"],
    diagnosis: makeDiagnosis("test expects wrong line index", "test_bug"),
    config: makeMinimalConfig(),
    workdir: "/tmp/workdir",
    featureName: "test-feature",
    storyId: "US-001",
    acceptanceTestPath: "/tmp/workdir/.nax/features/test-feature/.nax-acceptance.test.ts",
    ...overrides,
  };
}

function callBuildTestFixPrompt(options: ExecuteTestFixOptions): string {
  return new AcceptancePromptBuilder().buildTestFixPrompt({
    testOutput: options.testOutput,
    diagnosisReasoning: options.diagnosis.reasoning,
    failedACs: options.failedACs,
    previousFailure: options.previousFailure,
    acceptanceTestPath: options.acceptanceTestPath,
    testFileContent: options.testFileContent,
  });
}

// ---------------------------------------------------------------------------
// executeTestFix() tests
// ---------------------------------------------------------------------------

describe("executeTestFix()", () => {
  test("throws when agent is null", async () => {
    await expect(executeTestFix(null as unknown as IAgentManager, makeTestFixOptions())).rejects.toThrow(
      "[fix-executor] agentManager is required",
    );
  });

  test("calls agent.run() with sessionRole 'test-fix'", async () => {
    const agent = makeAgentManager();
    await executeTestFix(agent, makeTestFixOptions());
    expect(agent.run).toHaveBeenCalled();
  });

  test("returns { success: boolean, cost: number }", async () => {
    const agent = makeAgentManager();
    const result = await executeTestFix(agent, makeTestFixOptions());
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.cost).toBe("number");
  });

  test("success is true when agent.run() succeeds", async () => {
    const agent = makeAgentManager({ success: true, estimatedCostUsd: 0.05 });
    const result = await executeTestFix(agent, makeTestFixOptions());
    expect(result.success).toBe(true);
  });

  test("success is false when agent.run() fails", async () => {
    const agent = makeAgentManager({ success: false, estimatedCostUsd: 0.05 });
    const result = await executeTestFix(agent, makeTestFixOptions());
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildTestFixPrompt() tests
// ---------------------------------------------------------------------------

describe("buildTestFixPrompt()", () => {
  test("includes test output in the prompt", () => {
    const prompt = callBuildTestFixPrompt(
      makeTestFixOptions({
        testOutput: "FAIL: expected 3 got 4",
      }),
    );
    expect(prompt).toContain("FAIL: expected 3 got 4");
  });

  test("includes diagnosis reasoning", () => {
    const prompt = callBuildTestFixPrompt(
      makeTestFixOptions({
        diagnosis: makeDiagnosis("off-by-one in loop counter"),
      }),
    );
    expect(prompt).toContain("off-by-one in loop counter");
  });

  test("includes failedACs as comma-separated list", () => {
    const prompt = callBuildTestFixPrompt(
      makeTestFixOptions({
        failedACs: ["AC-1", "AC-2", "AC-3"],
      }),
    );
    expect(prompt).toContain("AC-1, AC-2, AC-3");
  });

  test("includes acceptance test path", () => {
    const prompt = callBuildTestFixPrompt(
      makeTestFixOptions({
        acceptanceTestPath: "/tmp/test/.nax/features/my-feature/.nax-acceptance.test.ts",
      }),
    );
    expect(prompt).toContain("/tmp/test/.nax/features/my-feature/.nax-acceptance.test.ts");
  });

  test("includes test file content when provided", () => {
    const prompt = callBuildTestFixPrompt(
      makeTestFixOptions({
        testFileContent: "import { test } from 'bun:test';",
      }),
    );
    expect(prompt).toContain("import { test } from 'bun:test';");
  });

  test("omits test file content section when testFileContent is empty", () => {
    const prompt = callBuildTestFixPrompt(
      makeTestFixOptions({
        testFileContent: "",
      }),
    );
    expect(prompt).not.toContain("CURRENT TEST FILE");
  });

  test("includes previousFailure context when provided", () => {
    const prompt = callBuildTestFixPrompt(
      makeTestFixOptions({
        previousFailure: "Previous attempt: wrong index used",
      }),
    );
    expect(prompt).toContain("Previous attempt: wrong index used");
  });
});
