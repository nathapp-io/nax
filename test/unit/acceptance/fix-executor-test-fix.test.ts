/**
 * Tests for executeTestFix() and buildTestFixPrompt() in src/acceptance/fix-executor.ts
 */

import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DiagnosisResult } from "../../../src/acceptance/types";
import { type ExecuteTestFixOptions, executeTestFix } from "../../../src/acceptance/fix-executor";
import { computeAcpHandle } from "../../../src/agents/acp/adapter";
import type { AgentAdapter, AgentResult } from "../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config/schema";
import { resolveModelForAgent } from "../../../src/config/schema-types";
import { AcceptancePromptBuilder } from "../../../src/prompts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockAgentAdapter(result?: Partial<AgentResult>): AgentAdapter {
  const defaultResult: AgentResult = {
    success: true,
    exitCode: 0,
    output: "console.log('fix applied');",
    rateLimited: false,
    durationMs: 1000,
    estimatedCost: 0.05,
  };
  const mockRun = mock(async () => ({ ...defaultResult, ...result }));
  const mockComplete = mock(async () => ({ output: "{}", costUsd: 0.01, source: "exact" as const }));
  const mockPlan = mock(async () => ({ stories: [], output: "", specContent: "" }));
  const mockDecompose = mock(async () => ({ stories: [], output: "" }));
  const mockIsInstalled = mock(async () => true);
  const mockBuildCommand = mock(() => ["mock", "cmd"]);
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 200000,
      features: new Set(["tdd", "review", "refactor"]),
    },
    isInstalled: mockIsInstalled,
    run: mockRun,
    buildCommand: mockBuildCommand,
    plan: mockPlan,
    decompose: mockDecompose,
    complete: mockComplete,
  } as unknown as AgentAdapter;
}

function getRunMockCalls(agent: AgentAdapter): Array<Parameters<AgentAdapter["run"]>> {
  return (agent.run as unknown as { mock: { calls: Array<Parameters<AgentAdapter["run"]>> } }).mock.calls;
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
    analyze: { ...DEFAULT_CONFIG.analyze },
    review: { ...DEFAULT_CONFIG.review },
    plan: { ...DEFAULT_CONFIG.plan },
    acceptance: {
      ...DEFAULT_CONFIG.acceptance,
      ...overrides,
    },
    context: { ...DEFAULT_CONFIG.context },
    agent: { protocol: "acp" },
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
    testFileContent: 'import { test, expect } from "bun:test";\ntest("AC-6", () => { expect(lines[1]).toMatch(/^  "id"/); });',
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
    await expect(executeTestFix(null as unknown as AgentAdapter, makeTestFixOptions())).rejects.toThrow(
      "[fix-executor] agent is required",
    );
  });

  test("calls agent.run() with sessionRole 'test-fix'", async () => {
    const agent = makeMockAgentAdapter();
    await executeTestFix(agent, makeTestFixOptions());
    const calls = getRunMockCalls(agent);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].sessionRole).toBe("test-fix");
  });

  test("session name follows nax-<hash>-<feature>-<storyId>-test-fix pattern (adapter derives handle)", async () => {
    const agent = makeMockAgentAdapter();
    await executeTestFix(agent, makeTestFixOptions());
    const calls = getRunMockCalls(agent);
    const expectedName = computeAcpHandle("/tmp/workdir", "test-feature", "US-001", "test-fix");
    expect(expectedName).toMatch(/^nax-[a-f0-9]+-test-feature-us-001-test-fix$/);
    expect(calls[0]?.[0].sessionRole).toBe("test-fix");
    expect(calls[0]?.[0].featureName).toBe("test-feature");
  });

  test("resolves fixModel via resolveModelForAgent()", async () => {
    const agent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeTestFix(agent, makeTestFixOptions({ config }));
    const calls = getRunMockCalls(agent);
    const expectedModelDef = resolveModelForAgent(
      config.models,
      config.agent?.default ?? "claude",
      config.acceptance.fix.fixModel,
      config.agent?.default ?? "claude",
    );
    expect(calls[0]?.[0].modelDef).toEqual(expectedModelDef);
  });

  test("prompt includes failing ACs list", async () => {
    const agent = makeMockAgentAdapter();
    await executeTestFix(agent, makeTestFixOptions({ failedACs: ["AC-6", "AC-7", "AC-9"] }));
    const calls = getRunMockCalls(agent);
    expect(calls[0]?.[0].prompt).toContain("AC-6, AC-7, AC-9");
  });

  test("prompt includes test output, diagnosis, and test file content", async () => {
    const agent = makeMockAgentAdapter();
    await executeTestFix(
      agent,
      makeTestFixOptions({
        testOutput: "FAILING_OUTPUT_MARKER",
        diagnosis: makeDiagnosis("DIAGNOSIS_MARKER", "test_bug"),
        testFileContent: "TEST_CONTENT_MARKER",
      }),
    );
    const calls = getRunMockCalls(agent);
    const prompt = calls[0]?.[0].prompt as string;
    expect(prompt).toContain("FAILING_OUTPUT_MARKER");
    expect(prompt).toContain("DIAGNOSIS_MARKER");
    expect(prompt).toContain("TEST_CONTENT_MARKER");
  });

  test("prompt includes previousFailure when provided", async () => {
    const agent = makeMockAgentAdapter();
    await executeTestFix(agent, makeTestFixOptions({ previousFailure: "PREVIOUS_ATTEMPT_MARKER" }));
    const calls = getRunMockCalls(agent);
    expect(calls[0]?.[0].prompt).toContain("PREVIOUS_ATTEMPT_MARKER");
  });

  test("prompt instructs to fix only failing assertions, not source code", async () => {
    const agent = makeMockAgentAdapter();
    await executeTestFix(agent, makeTestFixOptions());
    const calls = getRunMockCalls(agent);
    const prompt = calls[0]?.[0].prompt as string;
    expect(prompt).toContain("Fix ONLY the failing test assertions");
    expect(prompt).toContain("Do NOT modify passing tests");
    expect(prompt).toContain("Do NOT modify source code");
  });

  test("returns { success, cost } from agent.run() result", async () => {
    const agent = makeMockAgentAdapter({ success: true, estimatedCost: 0.42 });
    const result = await executeTestFix(agent, makeTestFixOptions());
    expect(result).toEqual({ success: true, cost: 0.42 });
  });

  test("returns success=false when agent.run() fails", async () => {
    const agent = makeMockAgentAdapter({ success: false, estimatedCost: 0.1 });
    const result = await executeTestFix(agent, makeTestFixOptions());
    expect(result).toEqual({ success: false, cost: 0.1 });
  });

  test("sets pipelineStage='acceptance'", async () => {
    const agent = makeMockAgentAdapter();
    await executeTestFix(agent, makeTestFixOptions());
    const calls = getRunMockCalls(agent);
    expect(calls[0]?.[0].pipelineStage).toBe("acceptance");
  });
});

// ---------------------------------------------------------------------------
// buildTestFixPrompt() tests
// ---------------------------------------------------------------------------

describe("buildTestFixPrompt()", () => {
  test("includes failing ACs in 'FAILING ACS:' section", () => {
    const prompt = callBuildTestFixPrompt(makeTestFixOptions({ failedACs: ["AC-1", "AC-2"] }));
    expect(prompt).toContain("FAILING ACS: AC-1, AC-2");
  });

  test("omits previousFailure section when not provided", () => {
    const prompt = callBuildTestFixPrompt(makeTestFixOptions({ previousFailure: undefined }));
    expect(prompt).not.toContain("PREVIOUS FAILED ATTEMPTS");
  });

  test("includes previousFailure section when provided", () => {
    const prompt = callBuildTestFixPrompt(makeTestFixOptions({ previousFailure: "attempt 1 failed" }));
    expect(prompt).toContain("PREVIOUS FAILED ATTEMPTS:\nattempt 1 failed");
  });
});
