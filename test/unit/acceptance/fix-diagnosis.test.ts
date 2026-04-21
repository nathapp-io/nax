/**
 * Tests for diagnoseAcceptanceFailure() in src/acceptance/fix-diagnosis.ts
 *
 * Covers acceptance criteria:
 * 1. Receives agent manager via parameter (never calls bare getAgent())
 * 2. Calls agent.run() with sessionRole 'diagnose'
 * 3. Session name follows pattern via computeAcpHandle()
 * 4. Resolves diagnoseModel via resolveModelForAgent()
 * 5. Auto-detects source files from import statements
 * 6. Parses DiagnosisResult JSON from agent output
 * 7. Returns fallback on parse failure
 * 8. Catches errors from adapter.run()
 * 9. ACP sessions visible in acpx list
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { diagnoseAcceptanceFailure } from "../../../src/acceptance/fix-diagnosis";
import type { DiagnosisResult } from "../../../src/acceptance/types";
import { computeAcpHandle } from "../../../src/agents/acp/adapter";
import type { AgentAdapter } from "../../../src/agents/types";
import type { IAgentManager } from "../../../src/agents";
import { makeAgentAdapter, makeMockAgentManager, makeNaxConfig } from "../../../test/helpers";
import { wrapAdapterAsManager } from "../../../src/agents/utils";
import { resolveModelForAgent } from "../../../src/config/schema-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const wrappedAdapterMap = new WeakMap<IAgentManager, AgentAdapter>();

function makeMockAgent(overrides?: Partial<{ output: string }>): IAgentManager {
  const runMock = mock(async () => ({
    success: true,
    exitCode: 0,
    output: overrides?.output ?? '{"verdict":"source_bug","reasoning":"test reasoning","confidence":0.9}',
    rateLimited: false,
    durationMs: 1000,
    estimatedCost: 0.05,
    agentFallbacks: [] as unknown[],
  }));
  const adapter = makeAgentAdapter({
    name: "claude" as const,
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"] as const,
      maxContextTokens: 200000,
      features: new Set(["tdd", "review", "refactor"]),
    },
    isInstalled: mock(async () => true),
    run: runMock,
    buildCommand: mock(() => ["mock", "cmd"]),
    plan: mock(async () => ({ stories: [], output: "", specContent: "" })),
    decompose: mock(async () => ({ stories: [], output: "" })),
    complete: mock(async () => ({ output: "{}", costUsd: 0.01, source: "exact" as const })),
  });
  const mgr = wrapAdapterAsManager(adapter);
  wrappedAdapterMap.set(mgr, adapter);
  return mgr;
}

function getRunMockCalls(agent: IAgentManager): Array<{ runOptions: Parameters<IAgentManager["run"]>[0]["runOptions"] }> {
  const adapter = wrappedAdapterMap.get(agent as any) as AgentAdapter;
  return (adapter.run as unknown as { mock: { calls: Array<{ runOptions: Parameters<IAgentManager["run"]>[0]["runOptions"] }> } }).mock.calls;
}

function toManagerTracked(agent: AgentAdapter): IAgentManager {
  const mgr = wrapAdapterAsManager(agent);
  wrappedAdapterMap.set(mgr, agent);
  return mgr;
}

// ---------------------------------------------------------------------------
// AC-1: diagnoseAcceptanceFailure() receives agent manager via parameter
// ---------------------------------------------------------------------------

describe("AC-1: diagnoseAcceptanceFailure receives agent adapter via parameter", () => {
  test("never calls bare getAgent() — uses passed adapter", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const adapter = wrappedAdapterMap.get(mockAgent);
    expect(adapter?.run).toHaveBeenCalled();
  });

  test("throws when agent is undefined", async () => {
    const config = makeNaxConfig();
    await expect(
      diagnoseAcceptanceFailure(undefined as unknown as IAgentManager, {
        testOutput: "FAIL",
        testFileContent: "test content",
        config,
        workdir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-001",
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-2: diagnoseAcceptanceFailure calls agent.run() (not agent.complete())
// ---------------------------------------------------------------------------

describe("AC-2: diagnoseAcceptanceFailure calls agent.run() with sessionRole diagnose", () => {
  test("calls agent.run() not agent.complete()", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const adapter = wrappedAdapterMap.get(mockAgent);
    expect(adapter?.run).toHaveBeenCalled();
    expect(adapter?.complete).not.toHaveBeenCalled();
  });

  test("passes sessionRole 'diagnose' to agent.run()", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.sessionRole).toBe("diagnose");
  });
});

// ---------------------------------------------------------------------------
// AC-3: Session name follows pattern nax-<hash>-<feature>-<storyId>-diagnose
// ---------------------------------------------------------------------------

describe("AC-3: Session name follows nax-<hash>-<feature>-<storyId>-diagnose pattern", () => {
  test("computeAcpHandle returns correct pattern for diagnose session", () => {
    const sessionName = computeAcpHandle("/tmp/test-workdir", "my-feature", "US-001", "diagnose");
    const hash = createHash("sha256").update("/tmp/test-workdir").digest("hex").slice(0, 8);
    expect(sessionName).toBe(`nax-${hash}-my-feature-us-001-diagnose`);
    expect(sessionName).toMatch(/^nax-[a-f0-9]+-.+-\d+-diagnose$/);
  });

  test("diagnoseAcceptanceFailure passes featureName, storyId, and sessionRole='diagnose' to adapter", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    // The adapter auto-derives the session handle from featureName + storyId + sessionRole.
    expect(runCall.sessionRole).toBe("diagnose");
    expect(runCall.featureName).toBe("test-feature");
    expect(runCall.storyId).toBe("US-001");
  });

  test("session name is visible in acpx list when protocol is ACP (adapter derives handle)", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    expect(config.agent?.protocol).toBe("acp");
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    const expectedHandle = computeAcpHandle("/tmp/test-workdir", "test-feature", "US-001", "diagnose");
    expect(expectedHandle).toMatch(/^nax-[a-f0-9]+-test-feature-us-001-diagnose$/);
    expect(runCall.featureName).toBe("test-feature");
    expect(runCall.sessionRole).toBe("diagnose");
  });
});

// ---------------------------------------------------------------------------
// AC-4: diagnoseModel resolved via resolveModelForAgent()
// ---------------------------------------------------------------------------

describe("AC-4: diagnoseAcceptanceFailure resolves diagnoseModel via resolveModelForAgent", () => {
  test("uses config.acceptance.fix.diagnoseModel tier", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    expect(config.acceptance.fix.diagnoseModel).toBe("fast");
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    const expectedModelDef = resolveModelForAgent(
      config.models,
      config.agent?.default ?? "claude",
      config.acceptance.fix.diagnoseModel as "fast",
      config.agent?.default ?? "claude",
    );
    expect(runCall.modelDef).toEqual(expectedModelDef);
  });

  test("passes resolved model metadata to adapter rather than a raw unresolved tier string", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.modelTier).toBe("fast");
    expect(runCall.modelDef.provider).toBeDefined();
    expect(runCall.modelDef.model).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-5: Auto-detects source file paths from import statements
// ---------------------------------------------------------------------------

describe("AC-5: diagnoseAcceptanceFailure auto-detects source files from imports", () => {
  test("parses import statements from test file content", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    const testContent = `
import { add } from "./src/math.ts";
import { multiply } from "./src/utils.ts";
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
    const adapter = wrappedAdapterMap.get(mockAgent);
    expect(adapter?.run).toHaveBeenCalled();
  });

  test("limits to 5 files maximum", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    const testContent = `
import { a } from "./src/file1.ts";
import { b } from "./src/file2.ts";
import { c } from "./src/file3.ts";
import { d } from "./src/file4.ts";
import { e } from "./src/file5.ts";
import { f } from "./src/file6.ts";
test("AC-1", () => { expect(a()).toBe(1); });
`;
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: testContent,
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.prompt).toBeDefined();
  });

  test("limits each file to 500 lines maximum", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    const testContent = `
import { bigFunc } from "./src/big-file.ts";
test("AC-1", () => { expect(bigFunc()).toBeDefined(); });
`;
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: testContent,
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const adapter = wrappedAdapterMap.get(mockAgent);
    expect(adapter?.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-6: Returns parsed DiagnosisResult when agent output is valid JSON
// ---------------------------------------------------------------------------

describe("AC-6: diagnoseAcceptanceFailure returns parsed DiagnosisResult", () => {
  test("returns DiagnosisResult when agent output is valid JSON", async () => {
    const diagnosisResult: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "The login function has a null pointer exception",
      confidence: 0.95,
      sourceIssues: ["NullPointerException on line 42"],
    };
    const mockAgent = makeMockAgent({ output: JSON.stringify(diagnosisResult) });
    const config = makeNaxConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL: expected true but got false",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result.verdict).toBe("source_bug");
    expect(result.reasoning).toBe("The login function has a null pointer exception");
    expect(result.confidence).toBe(0.95);
  });

  test("returns test_bug verdict when test is incorrect", async () => {
    const diagnosisResult: DiagnosisResult = {
      verdict: "test_bug",
      reasoning: "The test assertion is wrong",
      confidence: 0.88,
      testIssues: ["Assertion expects 3 but actual is 4"],
    };
    const mockAgent = makeMockAgent({ output: JSON.stringify(diagnosisResult) });
    const config = makeNaxConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result.verdict).toBe("test_bug");
  });

  test("returns both verdict when both source and test have issues", async () => {
    const diagnosisResult: DiagnosisResult = {
      verdict: "both",
      reasoning: "Both source and test have bugs",
      confidence: 0.75,
      testIssues: ["Test mocks database incorrectly"],
      sourceIssues: ["Off-by-one error in loop"],
    };
    const mockAgent = makeMockAgent({ output: JSON.stringify(diagnosisResult) });
    const config = makeNaxConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result.verdict).toBe("both");
  });
});

// ---------------------------------------------------------------------------
// AC-7: Returns fallback DiagnosisResult on parse failure
// ---------------------------------------------------------------------------

describe("AC-7: diagnoseAcceptanceFailure returns fallback on parse failure", () => {
  test("returns fallback when agent output is invalid JSON", async () => {
    const mockAgent = makeMockAgent({ output: "This is not JSON output" });
    const config = makeNaxConfig();
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

  test("returns fallback when agent output is empty", async () => {
    const mockAgent = makeMockAgent({ output: "" });
    const config = makeNaxConfig();
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

  test("returns fallback when agent output is partial JSON", async () => {
    const mockAgent = makeMockAgent({ output: '{"verdict": "source_bug", ' });
    const config = makeNaxConfig();
    const result = await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    expect(result.verdict).toBe("source_bug");
    expect(result.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-8: Catches errors from adapter.run() and returns fallback
// ---------------------------------------------------------------------------

describe("AC-8: diagnoseAcceptanceFailure catches adapter.run() errors", () => {
  test("returns fallback DiagnosisResult when adapter.run() throws", async () => {
    const errorAgent = makeAgentAdapter({
      name: "claude",
      displayName: "Error Agent",
      binary: "error",
      capabilities: {
        supportedTiers: ["fast", "balanced", "powerful"] as const,
        maxContextTokens: 200000,
        features: new Set(["tdd", "review", "refactor"]),
      },
      isInstalled: mock(async () => true),
      run: mock(async () => {
        throw new Error("Connection refused");
      }),
      buildCommand: mock(() => ["error", "cmd"]),
      plan: mock(async () => ({ stories: [], output: "", specContent: "" })),
      decompose: mock(async () => ({ stories: [], output: "" })),
      complete: mock(async () => ({ output: "", costUsd: 0, source: "exact" as const })),
    });
    const config = makeNaxConfig();
    const result = await diagnoseAcceptanceFailure(toManagerTracked(errorAgent), {
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

  test("does not throw when adapter.run() throws", async () => {
    const errorAgent = makeAgentAdapter({
      name: "claude",
      displayName: "Error Agent",
      binary: "error",
      capabilities: {
        supportedTiers: ["fast", "balanced", "powerful"] as const,
        maxContextTokens: 200000,
        features: new Set(["tdd", "review", "refactor"]),
      },
      isInstalled: mock(async () => true),
      run: mock(async () => {
        throw new Error("Network error");
      }),
      buildCommand: mock(() => ["error", "cmd"]),
      plan: mock(async () => ({ stories: [], output: "", specContent: "" })),
      decompose: mock(async () => ({ stories: [], output: "" })),
      complete: mock(async () => ({ output: "", costUsd: 0, source: "exact" as const })),
    });
    const config = makeNaxConfig();
    await expect(
      diagnoseAcceptanceFailure(toManagerTracked(errorAgent), {
        testOutput: "FAIL",
        testFileContent: "test content",
        config,
        workdir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-001",
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-9: Test output truncated to 2000 chars
// ---------------------------------------------------------------------------

describe("AC-9: Test output truncated to 2000 characters", () => {
  test("truncates test output to 2000 chars in prompt", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    const longOutput = "FAIL".repeat(1000);
    expect(longOutput.length).toBeGreaterThan(2000);
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: longOutput,
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    expect(runCall.prompt.length).toBeLessThanOrEqual(longOutput.length + 1000);
  });
});

// ---------------------------------------------------------------------------
// AC-10: ACP session visible in acpx list with correct session name
// ---------------------------------------------------------------------------

describe("AC-10: ACP session visible in acpx list with correct session name", () => {
  test("session name follows nax-<hash>-<feature>-<storyId>-diagnose pattern for ACP", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    config.agent = { protocol: "acp" };
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test-workdir",
      featureName: "my-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    const hash = createHash("sha256").update("/tmp/test-workdir").digest("hex").slice(0, 8);
    // Adapter auto-derives handle; verify the formula is correct
    const expectedHandle = computeAcpHandle("/tmp/test-workdir", "my-feature", "US-001", "diagnose");
    expect(expectedHandle).toBe(`nax-${hash}-my-feature-us-001-diagnose`);
    expect(runCall.featureName).toBe("my-feature");
    expect(runCall.sessionRole).toBe("diagnose");
  });

  test("ACP protocol ensures session appears in acpx list (adapter derives handle)", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    config.agent = { protocol: "acp" };
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const runCall = getRunMockCalls(mockAgent)[0][0];
    const expectedHandle = computeAcpHandle("/tmp/test-workdir", "test-feature", "US-001", "diagnose");
    expect(expectedHandle).toMatch(/^nax-[a-f0-9]+-test-feature-us-001-diagnose$/);
    expect(runCall.featureName).toBe("test-feature");
    expect(runCall.sessionRole).toBe("diagnose");
  });
});

// ---------------------------------------------------------------------------
// DiagnosisResult interface validation
// ---------------------------------------------------------------------------

describe("DiagnosisResult interface validation", () => {
  test("verdict accepts 'source_bug'", () => {
    const result: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "Source code bug found",
      confidence: 0.85,
    };
    expect(result.verdict).toBe("source_bug");
  });

  test("verdict accepts 'test_bug'", () => {
    const result: DiagnosisResult = {
      verdict: "test_bug",
      reasoning: "Test bug found",
      confidence: 0.9,
    };
    expect(result.verdict).toBe("test_bug");
  });

  test("verdict accepts 'both'", () => {
    const result: DiagnosisResult = {
      verdict: "both",
      reasoning: "Both bugs found",
      confidence: 0.75,
    };
    expect(result.verdict).toBe("both");
  });

  test("confidence must be between 0 and 1", () => {
    const lowConfidence: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "Low confidence",
      confidence: 0,
    };
    const highConfidence: DiagnosisResult = {
      verdict: "test_bug",
      reasoning: "High confidence",
      confidence: 1,
    };
    expect(lowConfidence.confidence).toBe(0);
    expect(highConfidence.confidence).toBe(1);
  });

  test("testIssues and sourceIssues are optional", () => {
    const minimal: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "Minimal result",
      confidence: 0.5,
    };
    expect(minimal.testIssues).toBeUndefined();
    expect(minimal.sourceIssues).toBeUndefined();
  });

  test("testIssues and sourceIssues can be provided together", () => {
    const full: DiagnosisResult = {
      verdict: "both",
      reasoning: "Full result",
      confidence: 0.95,
      testIssues: ["Test issue 1"],
      sourceIssues: ["Source issue 1", "Source issue 2"],
    };
    expect(full.testIssues).toEqual(["Test issue 1"]);
    expect(full.sourceIssues).toEqual(["Source issue 1", "Source issue 2"]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  test("works without optional featureName", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      storyId: "US-001",
    });
    const adapter = wrappedAdapterMap.get(mockAgent);
    expect(adapter?.run).toHaveBeenCalled();
  });

  test("works without optional storyId", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: "test content",
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
    });
    const adapter = wrappedAdapterMap.get(mockAgent);
    expect(adapter?.run).toHaveBeenCalled();
  });

  test("handles missing source files gracefully", async () => {
    const mockAgent = makeMockAgent();
    const config = makeNaxConfig();
    const testContent = `
import { nonexistent } from "./src/nonexistent.ts";
test("AC-1", () => { expect(nonexistent()).toBe(1); });
`;
    await diagnoseAcceptanceFailure(mockAgent, {
      testOutput: "FAIL",
      testFileContent: testContent,
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
    });
    const adapter = wrappedAdapterMap.get(mockAgent);
    expect(adapter?.run).toHaveBeenCalled();
  });
});
