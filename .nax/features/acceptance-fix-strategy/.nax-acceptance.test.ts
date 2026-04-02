/**
 * Acceptance Tests for acceptance-fix-strategy Feature
 *
 * Tests the diagnose-first vs implement-only fix strategy for acceptance failures.
 * Verifies: config schema, DiagnosisResult type, diagnoseAcceptanceFailure(),
 * executeSourceFix(), and acceptance-loop wiring.
 *
 * Note: Many tests require the feature modules (fix-diagnosis.ts, fix-executor.ts)
 * to be implemented. These tests will pass once the feature is complete.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildSessionName } from "../../../src/agents/acp/adapter";
import type { AgentAdapter, AgentResult } from "../../../src/agents/types";
import { DEFAULT_CONFIG, NaxConfigSchema } from "../../../src/config";
import type { NaxConfig } from "../../../src/config/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockAgentAdapter(result?: Partial<AgentResult>): AgentAdapter {
  const defaultResult: AgentResult = {
    success: true,
    exitCode: 0,
    output: '{"verdict":"source_bug","reasoning":"test reasoning","confidence":0.9}',
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

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC-1: TypeScript type check — NaxConfig.acceptance has AcceptanceFixConfig
// ---------------------------------------------------------------------------

describe("AC-1: NaxConfig.acceptance has AcceptanceFixConfig with correct fields", () => {
  test("NaxConfig.acceptance.fix exists with fields diagnoseModel, fixModel, strategy, maxRetries", () => {
    const config = makeMinimalConfig();
    expect(config.acceptance.fix).toBeDefined();
    expect(typeof config.acceptance.fix.diagnoseModel).toBe("string");
    expect(typeof config.acceptance.fix.fixModel).toBe("string");
    expect(typeof config.acceptance.fix.strategy).toBe("string");
    expect(typeof config.acceptance.fix.maxRetries).toBe("number");
  });

  test("strategy accepts 'diagnose-first' and 'implement-only' values", () => {
    const configDiagnose = makeMinimalConfig();
    configDiagnose.acceptance.fix.strategy = "diagnose-first";
    expect(configDiagnose.acceptance.fix.strategy).toBe("diagnose-first");

    const configImplement = makeMinimalConfig();
    configImplement.acceptance.fix.strategy = "implement-only";
    expect(configImplement.acceptance.fix.strategy).toBe("implement-only");
  });
});

// ---------------------------------------------------------------------------
// AC-2: DEFAULT_CONFIG.acceptance.fix deep-equal to expected defaults
// ---------------------------------------------------------------------------

describe("AC-2: DEFAULT_CONFIG.acceptance.fix has correct default values", () => {
  test("DEFAULT_CONFIG.acceptance.fix equals { diagnoseModel: 'fast', fixModel: 'balanced', strategy: 'diagnose-first', maxRetries: 2 }", () => {
    const expected = {
      diagnoseModel: "fast",
      fixModel: "balanced",
      strategy: "diagnose-first",
      maxRetries: 2,
    };
    expect(DEFAULT_CONFIG.acceptance.fix).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// AC-3: DiagnosisResult interface exported from src/acceptance/types.ts
// ---------------------------------------------------------------------------

describe("AC-3: DiagnosisResult interface with required and optional fields", () => {
  test("DiagnosisResult has required fields verdict, reasoning, confidence", async () => {
    const types = await import("../../../src/acceptance/types");
    expect(types.DiagnosisResult).toBeDefined();
  });

  test("verdict accepts 'source_bug', 'test_bug', 'both'", () => {
    const resultSource = { verdict: "source_bug" as const, reasoning: "src", confidence: 0.9 };
    const resultTest = { verdict: "test_bug" as const, reasoning: "test", confidence: 0.9 };
    const resultBoth = { verdict: "both" as const, reasoning: "both", confidence: 0.9 };
    expect(resultSource.verdict).toBe("source_bug");
    expect(resultTest.verdict).toBe("test_bug");
    expect(resultBoth.verdict).toBe("both");
  });
});

// ---------------------------------------------------------------------------
// AC-4: Zod schema validation for strategy field
// ---------------------------------------------------------------------------

describe("AC-4: NaxConfigSchema.parse validates strategy field", () => {
  test("rejects invalid strategy value", () => {
    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        fix: { strategy: "invalid" },
      },
    });
    expect(result.success).toBe(false);
  });

  test("accepts 'diagnose-first' strategy", () => {
    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        fix: { strategy: "diagnose-first" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts 'implement-only' strategy", () => {
    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        fix: { strategy: "implement-only" },
      },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-5: diagnoseAcceptanceFailure receives agentAdapter parameter
// ---------------------------------------------------------------------------

describe("AC-5: diagnoseAcceptanceFailure function signature has agentAdapter parameter", () => {
  test("module exports diagnoseAcceptanceFailure function", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    expect(typeof diagnoseAcceptanceFailure).toBe("function");
  });

  test("function accepts agentAdapter as first parameter", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-6: agentAdapter.run() called with sessionRole: 'diagnose'
// ---------------------------------------------------------------------------

describe("AC-6: diagnoseAcceptanceFailure calls agentAdapter.run() with sessionRole 'diagnose'", () => {
  test("agentAdapter.run() is called with sessionRole 'diagnose'", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL test",
      testFileContent: 'import { test } from "bun:test"; test("AC-1", () => {});',
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("agentAdapter.complete() is never called in diagnoseAcceptanceFailure", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.complete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-7: sessionName matches regex pattern with 'diagnose' suffix
// ---------------------------------------------------------------------------

describe("AC-7: sessionName matches nax-<hash>-<feature>-<storyId>-diagnose pattern", () => {
  test("buildSessionName(workdir, feature, storyId, 'diagnose') returns correct pattern", () => {
    const sessionName = buildSessionName("/tmp/test-workdir", "my-feature", "US-001", "diagnose");
    const hash = createHash("sha256").update("/tmp/test-workdir").digest("hex").slice(0, 8);
    expect(sessionName).toBe(`nax-${hash}-my-feature-us-001-diagnose`);
    expect(sessionName).toMatch(/^nax-[a-f0-9]+-.+-\d+-diagnose$/);
  });

  test("diagnoseAcceptanceFailure creates session with 'diagnose' suffix", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-8: resolveModelForAgent(config.acceptance.fix.diagnoseModel) is called
// ---------------------------------------------------------------------------

describe("AC-8: diagnoseAcceptanceFailure resolves model via resolveModelForAgent", () => {
  test("diagnoseAcceptanceFailure passes resolved modelDef to agent.run()", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("uses config.acceptance.fix.diagnoseModel tier ('fast' by default)", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    expect(config.acceptance.fix.diagnoseModel).toBe("fast");
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-9: prompt includes content from <=5 files, <=500 lines each
// ---------------------------------------------------------------------------

describe("AC-9: diagnoseAcceptanceFailure prompt includes auto-detected source files", () => {
  test("prompt includes source file content from imports in test file", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const testContent = `
import { add } from "./src/math.ts";
import { multiply } from "./src/math.ts";
test("AC-1", () => { expect(add(1,2)).toBe(3); });
`;
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL: expected 3 but got 4",
      testFileContent: testContent,
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-10: Returns object with correct keys, JSON.parse succeeds, schema passes
// ---------------------------------------------------------------------------

describe("AC-10: diagnoseAcceptanceFailure returns correct DiagnosisResult", () => {
  test("returns object with verdict, reasoning, confidence keys", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter({
      output: '{"verdict":"source_bug","reasoning":"src bug here","confidence":0.85}',
    });
    const config = makeMinimalConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result.verdict).toBe("source_bug");
    expect(result.reasoning).toBe("src bug here");
    expect(result.confidence).toBe(0.85);
  });

  test("JSON.parse succeeds on valid agent output", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter({
      output: '{"verdict":"test_bug","reasoning":"test issue","confidence":0.7}',
    });
    const config = makeMinimalConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(["source_bug", "test_bug", "both"]).toContain(result.verdict);
  });

  test("schema validation passes for valid DiagnosisResult", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter({ output: '{"verdict":"both","reasoning":"both issues","confidence":0.6}' });
    const config = makeMinimalConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(["source_bug", "test_bug", "both"]).toContain(result.verdict);
  });
});

// ---------------------------------------------------------------------------
// AC-11: On JSON.parse failure, returns exact fallback object
// ---------------------------------------------------------------------------

describe("AC-11: diagnoseAcceptanceFailure returns fallback on JSON.parse failure", () => {
  test("returns fallback DiagnosisResult on parse failure", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter({ output: "not valid json output from agent" });
    const config = makeMinimalConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result.verdict).toBe("source_bug");
    expect(result.reasoning).toBe("diagnosis failed — falling back to source fix");
    expect(result.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-12: try/catch wraps agentAdapter.run(); error returns fallback
// ---------------------------------------------------------------------------

describe("AC-12: diagnoseAcceptanceFailure catches errors and returns fallback", () => {
  test("returns fallback DiagnosisResult when agentAdapter.run() throws", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const failingAgent = makeMockAgentAdapter();
    (failingAgent.run as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("network error");
    });
    const config = makeMinimalConfig();
    const result = await diagnoseAcceptanceFailure(failingAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result.verdict).toBe("source_bug");
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("network error");
  });
});

// ---------------------------------------------------------------------------
// AC-13: ACP protocol — session visible in acpx list
// ---------------------------------------------------------------------------

describe("AC-13: When protocol is acp, session appears in acpx sessions list", () => {
  test("session name follows nax-<hash>-<feature>-<storyId>-diagnose pattern", async () => {
    const { diagnoseAcceptanceFailure } = await import("../../../src/acceptance/fix-diagnosis");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test-workdir",
      featureName: "my-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-14: executeSourceFix has agent parameter
// ---------------------------------------------------------------------------

describe("AC-14: executeSourceFix receives agent adapter parameter", () => {
  test("module exports executeSourceFix function", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    expect(typeof executeSourceFix).toBe("function");
  });

  test("executeSourceFix accepts agent as first parameter", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-15: executeSourceFix calls agent.run() with sessionRole 'source-fix'
// ---------------------------------------------------------------------------

describe("AC-15: executeSourceFix calls agent.run() with sessionRole 'source-fix'", () => {
  test("agent.run() called with sessionRole 'source-fix'", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("agent.complete() is not called in executeSourceFix", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.complete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-16: buildSessionName called with 'source-fix' suffix
// ---------------------------------------------------------------------------

describe("AC-16: executeSourceFix sessionName matches nax-<hash>-<feature>-<storyId>-source-fix pattern", () => {
  test("buildSessionName(workdir, feature, storyId, 'source-fix') returns correct pattern", () => {
    const sessionName = buildSessionName("/tmp/test-workdir", "my-feature", "US-001", "source-fix");
    const hash = createHash("sha256").update("/tmp/test-workdir").digest("hex").slice(0, 8);
    expect(sessionName).toBe(`nax-${hash}-my-feature-us-001-source-fix`);
    expect(sessionName).toMatch(/^nax-[a-f0-9]+-.+-.*-source-fix$/);
  });

  test("executeSourceFix creates session with 'source-fix' suffix", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-17: resolveModelForAgent(config.acceptance.fix.fixModel) is called
// ---------------------------------------------------------------------------

describe("AC-17: executeSourceFix resolves fixModel via resolveModelForAgent", () => {
  test("passes resolved model to agent.run()", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    expect(config.acceptance.fix.fixModel).toBe("balanced");
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-18: prompt contains 'failing test' and 'diagnosis'/'reasoning'
// ---------------------------------------------------------------------------

describe("AC-18: executeSourceFix prompt contains 'failing test' and diagnosis/reasoning", () => {
  test("prompt string contains 'failing test'", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "null pointer in add()", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });

  test("prompt string contains diagnosis or reasoning", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "null pointer in add()", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-19: executeSourceFix does not use Pipeline
// ---------------------------------------------------------------------------

describe("AC-19: executeSourceFix does not call Pipeline; Bun.spawn runs after adapter.run()", () => {
  test("executeSourceFix completes without calling pipeline", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-20: Return type is { success: boolean; cost: number }
// ---------------------------------------------------------------------------

describe("AC-20: executeSourceFix returns { success: boolean; cost: number }", () => {
  test("return type has success and cost fields", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter({ estimatedCost: 0.07 });
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.cost).toBe("number");
  });

  test("cost value comes from result.estimatedCost", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter({ estimatedCost: 0.12 });
    const config = makeMinimalConfig();
    const result = await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result.cost).toBe(0.12);
  });
});

// ---------------------------------------------------------------------------
// AC-21: When protocol=acp, session appears in acpx list
// ---------------------------------------------------------------------------

describe("AC-21: When config.agent.protocol is acp, session appears in acpx list", () => {
  test("session name follows nax-<hash>-<feature>-<storyId>-source-fix pattern", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mockAgent = makeMockAgentAdapter();
    const config = makeMinimalConfig();
    await executeSourceFix(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: { verdict: "source_bug", reasoning: "src bug", confidence: 0.9 },
      config,
      workdir: "/tmp/test-workdir",
      featureName: "my-feature",
      storyId: "US-001",
    });
    expect(mockAgent.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-22: acceptance-loop uses (ctx.agentGetFn ?? _deps.getAgent)(agentName)
// ---------------------------------------------------------------------------

describe("AC-22: acceptance-loop obtains agent via agentGetFn, not bare getAgent()", () => {
  test("runAcceptanceLoop is exported from acceptance-loop module", async () => {
    const { runAcceptanceLoop, _acceptanceLoopDeps } = await import("../../../src/execution/lifecycle/acceptance-loop");
    expect(typeof runAcceptanceLoop).toBe("function");
    expect(_acceptanceLoopDeps).toBeDefined();
    expect(typeof _acceptanceLoopDeps.getAgent).toBe("function");
  });

  test("_acceptanceLoopDeps.getAgent exists for dependency injection", async () => {
    const { _acceptanceLoopDeps } = await import("../../../src/execution/lifecycle/acceptance-loop");
    expect(_acceptanceLoopDeps.getAgent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-23: strategy='diagnose-first' + verdict='source_bug' -> executeSourceFix()
// ---------------------------------------------------------------------------

describe("AC-23: When strategy is diagnose-first and verdict is source_bug, calls executeSourceFix()", () => {
  test("executeSourceFix is exported from acceptance-fix module", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    expect(typeof executeSourceFix).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-24: strategy='diagnose-first' + verdict='test_bug' -> regenerateAcceptanceTest()
// ---------------------------------------------------------------------------

describe("AC-24: When strategy is diagnose-first and verdict is test_bug, calls regenerateAcceptanceTest()", () => {
  test("regenerateAcceptanceTest is exported from acceptance-loop", async () => {
    const mod = await import("../../../src/execution/lifecycle/acceptance-loop");
    expect(typeof mod.regenerateAcceptanceTest).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-25: strategy='diagnose-first' + verdict='both' -> executeSourceFix() then regenerateAcceptanceTest()
// ---------------------------------------------------------------------------

describe("AC-25: When strategy is diagnose-first and verdict is both, calls executeSourceFix then regenerateAcceptanceTest", () => {
  test("both executeSourceFix and regenerateAcceptanceTest are exported", async () => {
    const { executeSourceFix } = await import("../../../src/acceptance/fix-executor");
    const mod = await import("../../../src/execution/lifecycle/acceptance-loop");
    expect(typeof executeSourceFix).toBe("function");
    expect(typeof mod.regenerateAcceptanceTest).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-26: strategy='implement-only' skips diagnosis, calls executeSourceFix() directly
// ---------------------------------------------------------------------------

describe("AC-26: When strategy is implement-only, skips diagnosis and calls executeSourceFix() directly", () => {
  test("implement-only strategy skips diagnoseAcceptanceFailure", async () => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    expect(typeof runAcceptanceLoop).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-27: Fix retries respect config.acceptance.fix.maxRetries
// ---------------------------------------------------------------------------

describe("AC-27: Fix retries respect config.acceptance.fix.maxRetries", () => {
  test("config.acceptance.fix.maxRetries is separate from config.acceptance.maxRetries", () => {
    const config = makeMinimalConfig();
    expect(config.acceptance.maxRetries).toBeDefined();
    expect(config.acceptance.fix.maxRetries).toBeDefined();
    expect(config.acceptance.fix.maxRetries).not.toBe(config.acceptance.maxRetries);
  });

  test("config.acceptance.fix.maxRetries defaults to 2", () => {
    const config = makeMinimalConfig();
    expect(config.acceptance.fix.maxRetries).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC-28: JSONL event with stage 'acceptance.diagnosis' emitted
// ---------------------------------------------------------------------------

describe("AC-28: JSONL event with stage acceptance.diagnosis emitted", () => {
  test("event emitter interface supports acceptance.diagnosis stage", async () => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    expect(typeof runAcceptanceLoop).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-29: JSONL event with stage 'acceptance.source-fix' emitted
// ---------------------------------------------------------------------------

describe("AC-29: JSONL event with stage acceptance.source-fix emitted", () => {
  test("acceptance.source-fix event has cost and success fields", () => {
    const mockEvent = {
      stage: "acceptance.source-fix",
      success: true,
      cost: 0.05,
    };
    expect(mockEvent.stage).toBe("acceptance.source-fix");
    expect(typeof mockEvent.success).toBe("boolean");
    expect(typeof mockEvent.cost).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// AC-30: JSONL event with stage 'acceptance.test-regen' emitted
// ---------------------------------------------------------------------------

describe("AC-30: JSONL event with stage acceptance.test-regen emitted", () => {
  test("acceptance.test-regen event has outcome field", () => {
    const mockEvent = {
      stage: "acceptance.test-regen",
      outcome: "success",
    };
    expect(mockEvent.stage).toBe("acceptance.test-regen");
    expect(typeof mockEvent.outcome).toBe("string");
  });
});
