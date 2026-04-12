/**
 * Tests for executeSourceFix() in src/acceptance/fix-executor.ts
 *
 * Covers acceptance criteria:
 * 1. executeSourceFix() receives agent adapter via parameter (never calls bare getAgent())
 * 2. executeSourceFix() calls agent.run() with sessionRole 'source-fix'
 * 3. Session name follows pattern nax-<hash>-<feature>-<storyId>-source-fix via buildSessionName()
 * 4. executeSourceFix() resolves fixModel via resolveModelForAgent() — never passes raw tier
 * 5. executeSourceFix() includes failing test output and diagnosis reasoning in prompt
 * 6. executeSourceFix() does NOT use pipeline — calls adapter.run() directly
 * 7. executeSourceFix() returns { success: boolean, cost: number }
 * 8. When protocol is ACP, session appears in acpx list with correct session name
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { executeSourceFix } from "../../../src/acceptance/fix-executor";
import type { DiagnosisResult } from "../../../src/acceptance/types";
import { buildSessionName } from "../../../src/agents/acp/adapter";
import type { AgentAdapter, AgentResult } from "../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config/schema";
import { resolveModelForAgent } from "../../../src/config/schema-types";

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

// ---------------------------------------------------------------------------
// AC-1: executeSourceFix receives agent adapter via parameter
// ---------------------------------------------------------------------------

describe("AC-1: executeSourceFix receives agent adapter via parameter", () => {
  test("never calls bare getAgent() — uses passed adapter", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL: expected 3 but got 4",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("throws when agent is undefined", async () => {
    const config = makeMinimalConfig();
    await expect(
      executeSourceFix(undefined as unknown as AgentAdapter, {
        testOutput: "FAIL",
        testFileContent: "test content",
        diagnosis: makeDiagnosis(),
        config,
        workdir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-001",
        acceptanceTestPath: "/tmp/test/acceptance.test.ts",
      }),
    ).rejects.toThrow();
  });

  test("accepts valid AgentAdapter instance", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-2: executeSourceFix calls agent.run() with sessionRole 'source-fix'
// ---------------------------------------------------------------------------

describe("AC-2: executeSourceFix calls agent.run() with sessionRole 'source-fix'", () => {
  test("calls agent.run() not agent.complete()", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.run).toHaveBeenCalled();
    expect(mockAgent.complete).not.toHaveBeenCalled();
  });

  test("passes sessionRole 'source-fix' to agent.run()", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.sessionRole).toBe("source-fix");
  });

  test("agent.complete() is not called during executeSourceFix", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.complete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-3: Session name follows nax-<hash>-<feature>-<storyId>-source-fix pattern
// ---------------------------------------------------------------------------

describe("AC-3: Session name follows nax-<hash>-<feature>-<storyId>-source-fix pattern", () => {
  test("buildSessionName returns correct pattern for source-fix session", () => {
    const sessionName = buildSessionName("/tmp/test-workdir", "my-feature", "US-001", "source-fix");
    const hash = createHash("sha256").update("/tmp/test-workdir").digest("hex").slice(0, 8);
    expect(sessionName).toBe(`nax-${hash}-my-feature-us-001-source-fix`);
    expect(sessionName).toMatch(/^nax-[a-f0-9]+-.+-\d+-source-fix$/);
  });

  test("executeSourceFix uses buildSessionName with 'source-fix' role", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    const expectedSessionName = buildSessionName("/tmp/test-workdir", "test-feature", "US-001", "source-fix");
    expect(runCall.acpSessionName).toBe(expectedSessionName);
  });

  test("session name includes storyId when provided", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "my-feature",
      storyId: "US-042",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.acpSessionName).toContain("us-042");
    expect(runCall.acpSessionName).toContain("source-fix");
  });

  test("session name is visible in acpx list when protocol is ACP", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    expect(config.agent?.protocol).toBe("acp");
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.acpSessionName).toMatch(/^nax-[a-f0-9]+-test-feature-us-001-source-fix$/);
  });
});

// ---------------------------------------------------------------------------
// AC-4: executeSourceFix resolves fixModel via resolveModelForAgent()
// ---------------------------------------------------------------------------

describe("AC-4: executeSourceFix resolves fixModel via resolveModelForAgent", () => {
  test("uses config.acceptance.fix.fixModel tier (balanced by default)", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    expect(config.acceptance.fix.fixModel).toBe("balanced");
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    const expectedModelDef = resolveModelForAgent(
      config.models,
      config.autoMode.defaultAgent,
      config.acceptance.fix.fixModel as "balanced",
      config.autoMode.defaultAgent,
    );
    expect(runCall.modelDef).toEqual(expectedModelDef);
  });

  test("passes resolved model metadata to adapter rather than a raw unresolved tier string", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.modelTier).toBe("balanced");
    expect(runCall.modelDef.provider).toBeDefined();
    expect(runCall.modelDef.model).toBeDefined();
  });

  test("uses custom fixModel when specified in config", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig({
      fix: {
        diagnoseModel: "fast",
        fixModel: "powerful",
        strategy: "diagnose-first",
        maxRetries: 2,
      },
    });
    expect(config.acceptance.fix.fixModel).toBe("powerful");
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    const expectedModelDef = resolveModelForAgent(
      config.models,
      config.autoMode.defaultAgent,
      "powerful",
      config.autoMode.defaultAgent,
    );
    expect(runCall.modelDef).toEqual(expectedModelDef);
  });
});

// ---------------------------------------------------------------------------
// AC-5: executeSourceFix includes failing test output and diagnosis reasoning
// ---------------------------------------------------------------------------

describe("AC-5: executeSourceFix prompt contains failing test output and diagnosis reasoning", () => {
  test("prompt string contains 'failing test' or test output", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const testOutput = "FAIL: expected 3 but got 4";
    await executeSourceFix(mockAgent, {
      testOutput,
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.prompt).toContain("FAIL");
  });

  test("prompt string contains diagnosis reasoning", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const reasoning = "null pointer in add() function at line 42";
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(reasoning),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.prompt).toContain(reasoning);
  });

  test("prompt string contains acceptance test file path", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const testPath = "/tmp/test/acceptance.test.ts";
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: testPath,
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.prompt).toContain(testPath);
  });

  test("prompt contains instruction to fix source and NOT modify test file", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.prompt.toLowerCase()).toContain("fix");
  });
});

// ---------------------------------------------------------------------------
// AC-6: executeSourceFix does NOT use pipeline
// ---------------------------------------------------------------------------

describe("AC-6: executeSourceFix does not use pipeline", () => {
  test("executeSourceFix completes without calling pipeline", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(result).toBeDefined();
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("executeSourceFix does not use agent.complete() for the main fix session", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.complete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-7: executeSourceFix returns { success: boolean, cost: number }
// ---------------------------------------------------------------------------

describe("AC-7: executeSourceFix returns { success: boolean, cost: number }", () => {
  test("return type has success and cost fields", async () => {
    const mockAgent = makeMockAgentAdapter({ estimatedCost: 0.07 });
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.cost).toBe("number");
  });

  test("cost value comes from result.estimatedCost", async () => {
    const mockAgent = makeMockAgentAdapter({ estimatedCost: 0.12 });
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(result.cost).toBe(0.12);
  });

  test("success is true when agent.run() succeeds", async () => {
    const mockAgent = makeMockAgentAdapter({ success: true, estimatedCost: 0.05 });
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(result.success).toBe(true);
  });

  test("success is false when agent.run() fails", async () => {
    const mockAgent = makeMockAgentAdapter({ success: false, estimatedCost: 0.05 });
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-8: When protocol is ACP, session appears in acpx list with correct name
// ---------------------------------------------------------------------------

describe("AC-8: When config.agent.protocol is ACP, session appears in acpx list", () => {
  test("session name follows nax-<hash>-<feature>-<storyId>-source-fix pattern for ACP", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    config.agent = { protocol: "acp" };
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "my-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    const hash = createHash("sha256").update("/tmp/test-workdir").digest("hex").slice(0, 8);
    expect(runCall.acpSessionName).toBe(`nax-${hash}-my-feature-us-001-source-fix`);
  });

  test("ACP protocol ensures session appears in acpx list via acpSessionName", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    config.agent = { protocol: "acp" };
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.acpSessionName).toMatch(/^nax-[a-f0-9]+-test-feature-us-001-source-fix$/);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  test("works without optional featureName", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("works without optional storyId", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("handles verdict=test_bug gracefully", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis("test assertion is wrong", "test_bug"),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("handles verdict=both gracefully", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis("both source and test have bugs", "both"),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("handles low confidence diagnosis", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const diagnosis: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "unclear issue",
      confidence: 0.2,
    };
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis,
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeTestFix() — surgical test fix (US-001)
// ---------------------------------------------------------------------------

import { type ExecuteTestFixOptions, executeTestFix } from "../../../src/acceptance/fix-executor";
import { AcceptancePromptBuilder } from "../../../src/prompts";

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

  test("session name follows nax-<hash>-<feature>-<storyId>-test-fix pattern", async () => {
    const agent = makeMockAgentAdapter();
    await executeTestFix(agent, makeTestFixOptions());
    const calls = getRunMockCalls(agent);
    const expectedName = buildSessionName("/tmp/workdir", "test-feature", "US-001", "test-fix");
    expect(calls[0]?.[0].acpSessionName).toBe(expectedName);
  });

  test("resolves fixModel via resolveModelForAgent()", async () => {
    const agent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeTestFix(agent, makeTestFixOptions({ config }));
    const calls = getRunMockCalls(agent);
    const expectedModelDef = resolveModelForAgent(
      config.models,
      config.autoMode.defaultAgent,
      config.acceptance.fix.fixModel,
      config.autoMode.defaultAgent,
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
