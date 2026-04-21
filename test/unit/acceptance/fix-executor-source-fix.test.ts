/**
 * Tests for executeSourceFix() in src/acceptance/fix-executor.ts
 *
 * Covers AC-1 through AC-8: agent adapter wiring, sessionRole, session naming,
 * model resolution, prompt content, pipeline bypass, return shape, ACP protocol.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { executeSourceFix } from "../../../src/acceptance/fix-executor";
import type { DiagnosisResult } from "../../../src/acceptance/types";
import { computeAcpHandle } from "../../../src/agents/acp/adapter";
import type { AgentAdapter, AgentResult } from "../../../src/agents/types";
import type { IAgentManager } from "../../../src/agents";
import { wrapAdapterAsManager } from "../../../src/agents/utils";
import { makeAgentAdapter, makeNaxConfig } from "../../../test/helpers";
import { resolveModelForAgent } from "../../../src/config/schema-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const wrappedAdapterMap = new WeakMap<IAgentManager, AgentAdapter>();

function toManager(agent: AgentAdapter): IAgentManager {
  const mgr = wrapAdapterAsManager(agent);
  wrappedAdapterMap.set(mgr, agent);
  return mgr;
}

function makeMockAgentAdapter(result?: Partial<AgentResult>): AgentAdapter {
  return makeAgentAdapter({
    name: "claude",
    run: mock(async () => ({
      success: true,
      exitCode: 0,
      output: "console.log('fix applied');",
      rateLimited: false,
      durationMs: 1000,
      estimatedCost: 0.05,
      ...result,
    })),
  });
}

function getRunMockCalls(agent: IAgentManager): Array<{ runOptions: Parameters<IAgentManager["run"]>[0]["runOptions"] }> {
  const adapter = wrappedAdapterMap.get(agent as any) as AgentAdapter;
  return (adapter.run as unknown as { mock: { calls: Array<{ runOptions: Parameters<IAgentManager["run"]>[0]["runOptions"] }> } }).mock.calls;
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
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
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

  test("throws when agent is undefined", () => {
    const config = makeNaxConfig();
    expect(
      () => executeSourceFix(undefined as unknown as IAgentManager, {
        testOutput: "FAIL",
        testFileContent: "test content",
        diagnosis: makeDiagnosis(),
        config,
        workdir: "/tmp/test",
        featureName: "test-feature",
        storyId: "US-001",
        acceptanceTestPath: "/tmp/test/acceptance.test.ts",
      }),
    ).toThrow();
  });

  test("accepts valid AgentAdapter instance", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    const result = await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    expect(runCall.sessionRole).toBe("source-fix");
  });

  test("agent.complete() is not called during executeSourceFix", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
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
  test("computeAcpHandle returns correct pattern for source-fix session", () => {
    const sessionName = computeAcpHandle("/tmp/test-workdir", "my-feature", "US-001", "source-fix");
    const hash = createHash("sha256").update("/tmp/test-workdir").digest("hex").slice(0, 8);
    expect(sessionName).toBe(`nax-${hash}-my-feature-us-001-source-fix`);
    expect(sessionName).toMatch(/^nax-[a-f0-9]+-.+-\d+-source-fix$/);
  });

  test("executeSourceFix passes featureName, storyId, and sessionRole='source-fix' to adapter", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    expect(runCall.sessionRole).toBe("source-fix");
    expect(runCall.featureName).toBe("test-feature");
    expect(runCall.storyId).toBe("US-001");
  });

  test("session includes storyId when provided (via featureName+storyId+sessionRole combo)", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "my-feature",
      storyId: "US-042",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    expect(runCall.storyId).toBe("US-042");
    expect(runCall.sessionRole).toBe("source-fix");
  });

  test("session name is visible in acpx list when protocol is ACP (adapter derives handle from featureName+storyId+sessionRole)", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    expect(config.agent?.protocol).toBe("acp");
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    const expectedName = computeAcpHandle("/tmp/test-workdir", "test-feature", "US-001", "source-fix");
    expect(expectedName).toMatch(/^nax-[a-f0-9]+-test-feature-us-001-source-fix$/);
    expect(runCall.featureName).toBe("test-feature");
  });
});

// ---------------------------------------------------------------------------
// AC-4: executeSourceFix resolves fixModel via resolveModelForAgent()
// ---------------------------------------------------------------------------

describe("AC-4: executeSourceFix resolves fixModel via resolveModelForAgent", () => {
  test("uses config.acceptance.fix.fixModel tier (balanced by default)", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    expect(config.acceptance.fix.fixModel).toBe("balanced");
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    const expectedModelDef = resolveModelForAgent(
      config.models,
      config.agent?.default ?? "claude",
      config.acceptance.fix.fixModel as "balanced",
      config.agent?.default ?? "claude",
    );
    expect(runCall.modelDef).toEqual(expectedModelDef);
  });

  test("passes resolved model metadata to adapter rather than a raw unresolved tier string", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    expect(runCall.modelTier).toBe("balanced");
    expect(runCall.modelDef.provider).toBeDefined();
    expect(runCall.modelDef.model).toBeDefined();
  });

  test("uses custom fixModel when specified in config", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig({
      acceptance: {
        fix: {
          diagnoseModel: "fast",
          fixModel: "powerful",
          strategy: "diagnose-first",
          maxRetries: 2,
        },
      },
    });
    expect(config.acceptance.fix.fixModel).toBe("powerful");
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    const expectedModelDef = resolveModelForAgent(
      config.models,
      config.agent?.default ?? "claude",
      "powerful",
      config.agent?.default ?? "claude",
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
    const config = makeNaxConfig();
    const testOutput = "FAIL: expected 3 but got 4";
    await executeSourceFix(toManager(mockAgent), {
      testOutput,
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    expect(runCall.prompt).toContain("FAIL");
  });

  test("prompt string contains diagnosis reasoning", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    const reasoning = "null pointer in add() function at line 42";
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(reasoning),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    expect(runCall.prompt).toContain(reasoning);
  });

  test("prompt string contains acceptance test file path", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    const testPath = "/tmp/test/acceptance.test.ts";
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: testPath,
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    expect(runCall.prompt).toContain(testPath);
  });

  test("prompt contains instruction to fix source and NOT modify test file", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    expect(runCall.prompt.toLowerCase()).toContain("fix");
  });
});

// ---------------------------------------------------------------------------
// AC-6: executeSourceFix does NOT use pipeline
// ---------------------------------------------------------------------------

describe("AC-6: executeSourceFix does not use pipeline", () => {
  test("executeSourceFix completes without calling pipeline", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    const result = await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    const result = await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    const result = await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    const result = await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    const result = await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    config.agent = { protocol: "acp" };
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "my-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    const hash = createHash("sha256").update("/tmp/test-workdir").digest("hex").slice(0, 8);
    const expectedHandle = computeAcpHandle("/tmp/test-workdir", "my-feature", "US-001", "source-fix");
    expect(expectedHandle).toBe(`nax-${hash}-my-feature-us-001-source-fix`);
    expect(runCall.featureName).toBe("my-feature");
    expect(runCall.sessionRole).toBe("source-fix");
  });

  test("ACP protocol ensures session appears in acpx list (adapter derives handle from featureName+storyId+sessionRole)", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    config.agent = { protocol: "acp" };
    await executeSourceFix(toManager(mockAgent), {
      testOutput: "FAIL",
      testFileContent: "test content",
      diagnosis: makeDiagnosis(),
      config,
      workdir: "/tmp/test-workdir",
      featureName: "test-feature",
      storyId: "US-001",
      acceptanceTestPath: "/tmp/test/acceptance.test.ts",
    });
    const runCall = getRunMockCalls(toManager(mockAgent))[0][0];
    const expectedHandle = computeAcpHandle("/tmp/test-workdir", "test-feature", "US-001", "source-fix");
    expect(expectedHandle).toMatch(/^nax-[a-f0-9]+-test-feature-us-001-source-fix$/);
    expect(runCall.featureName).toBe("test-feature");
    expect(runCall.sessionRole).toBe("source-fix");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases — executeSourceFix", () => {
  test("works without optional featureName", async () => {
    const mockAgent = makeMockAgentAdapter();
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    await executeSourceFix(toManager(mockAgent), {
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
    const config = makeNaxConfig();
    const diagnosis: DiagnosisResult = {
      verdict: "source_bug",
      reasoning: "unclear issue",
      confidence: 0.2,
    };
    await executeSourceFix(toManager(mockAgent), {
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
