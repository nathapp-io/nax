/**
 * Tests for src/execution/lifecycle/acceptance-fix.ts
 *
 * Covers US-004: resolveAcceptanceDiagnosis fast paths
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _applyFixDeps,
  applyFix,
  resolveAcceptanceDiagnosis,
} from "../../../../src/execution/lifecycle/acceptance-fix";
import type { DiagnoseOptions } from "../../../../src/acceptance/fix-diagnosis";
import type { DiagnosisResult, SemanticVerdict } from "../../../../src/acceptance/types";
import type { AgentAdapter } from "../../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { NaxConfig } from "../../../../src/config/schema";
import type { AcceptanceLoopContext } from "../../../../src/execution/lifecycle/acceptance-loop";

function makeMockAgent(): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock",
    binary: "mock",
    capabilities: { supportedTiers: ["fast"], maxContextTokens: 100000, features: new Set() },
    isInstalled: mock(async () => true),
    run: mock(async () => ({
      success: true,
      exitCode: 0,
      output: '{"verdict":"source_bug","reasoning":"LLM diagnosis","confidence":0.8}',
      rateLimited: false,
      durationMs: 100,
      estimatedCost: 0.01,
    })),
    buildCommand: mock(() => []),
    plan: mock(async () => ({ stories: [], output: "", specContent: "" })),
    decompose: mock(async () => ({ stories: [], output: "" })),
    complete: mock(async () => ({ output: "{}", costUsd: 0.01, source: "exact" as const })),
  } as unknown as AgentAdapter;
}

function makeConfig(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    agent: { protocol: "acp" },
  } as NaxConfig;
}

function makeDiagnosisOpts(): Omit<DiagnoseOptions, "previousFailure" | "semanticVerdicts"> {
  return {
    testOutput: "(fail) AC-1: failed",
    testFileContent: "test('AC-1', () => {});",
    config: makeConfig(),
    workdir: "/tmp/workdir",
    featureName: "test-feature",
    storyId: "US-001",
  };
}

describe("resolveAcceptanceDiagnosis() — fast paths", () => {
  test("implement-only strategy → source_bug, no LLM call", async () => {
    const agent = makeMockAgent();
    const result = await resolveAcceptanceDiagnosis({
      agent,
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      totalACs: 10,
      strategy: "implement-only",
      semanticVerdicts: [],
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(result.verdict).toBe("source_bug");
    expect(result.confidence).toBe(1.0);
    expect(agent.run).not.toHaveBeenCalled();
  });

  test("all semantic verdicts passed → test_bug, no LLM call", async () => {
    const agent = makeMockAgent();
    const verdicts: SemanticVerdict[] = [
      { storyId: "US-001", passed: true, timestamp: "2026-01-01T00:00:00Z", acCount: 5, findings: [] },
      { storyId: "US-002", passed: true, timestamp: "2026-01-01T00:00:00Z", acCount: 3, findings: [] },
    ];
    const result = await resolveAcceptanceDiagnosis({
      agent,
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: verdicts,
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(result.verdict).toBe("test_bug");
    expect(result.confidence).toBe(1.0);
    expect(result.reasoning).toContain("Semantic review confirmed");
    expect(agent.run).not.toHaveBeenCalled();
  });

  test(">80% ACs failed → test_bug, no LLM call", async () => {
    const agent = makeMockAgent();
    const result = await resolveAcceptanceDiagnosis({
      agent,
      failures: { failedACs: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9"], testOutput: "fail" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: [],
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(result.verdict).toBe("test_bug");
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toContain("Test-level failure");
    expect(agent.run).not.toHaveBeenCalled();
  });

  test("AC-ERROR sentinel → test_bug, no LLM call", async () => {
    const agent = makeMockAgent();
    const result = await resolveAcceptanceDiagnosis({
      agent,
      failures: { failedACs: ["AC-ERROR"], testOutput: "test crashed" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: [],
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(result.verdict).toBe("test_bug");
    expect(agent.run).not.toHaveBeenCalled();
  });

  test("normal failure (no fast path matches) → calls diagnoseAcceptanceFailure", async () => {
    const agent = makeMockAgent();
    const result = await resolveAcceptanceDiagnosis({
      agent,
      failures: { failedACs: ["AC-1", "AC-2"], testOutput: "(fail) AC-1\n(fail) AC-2" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: [
        { storyId: "US-001", passed: false, timestamp: "2026-01-01T00:00:00Z", acCount: 5, findings: [] },
      ],
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(agent.run).toHaveBeenCalled();
    expect(result.verdict).toBe("source_bug"); // from mock agent output
  });

  test("normal path passes previousFailure to diagnosis", async () => {
    const agent = makeMockAgent();
    await resolveAcceptanceDiagnosis({
      agent,
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: [],
      diagnosisOpts: makeDiagnosisOpts(),
      previousFailure: "PREVIOUS_MARKER",
    });
    const calls = (agent.run as unknown as { mock: { calls: Array<[{ prompt: string }]> } }).mock.calls;
    expect(calls[0]?.[0].prompt).toContain("PREVIOUS_MARKER");
  });
});

// ─── applyFix() — single-attempt fix orchestration (US-003) ─────────────────

function makeAcceptanceCtx(): AcceptanceLoopContext {
  return {
    config: makeConfig(),
    prd: { userStories: [{ id: "US-001" }] } as unknown as AcceptanceLoopContext["prd"],
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/workdir",
    featureDir: "/tmp/features/test",
    feature: "test-feature",
    hooks: {} as AcceptanceLoopContext["hooks"],
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 0,
    allStoryMetrics: [],
    pluginRegistry: {} as AcceptanceLoopContext["pluginRegistry"],
    statusWriter: {} as AcceptanceLoopContext["statusWriter"],
    agentGetFn: mock(() => makeMockAgent()),
    acceptanceTestPaths: [{ testPath: "/tmp/features/test/.nax-acceptance.test.ts", packageDir: "/tmp/workdir" }],
  };
}

function makeApplyFixDiagnosis(verdict: DiagnosisResult["verdict"] = "source_bug"): DiagnosisResult {
  return { verdict, reasoning: "test reasoning", confidence: 0.9 };
}

let origExecuteSourceFix: typeof _applyFixDeps.executeSourceFix;
let origExecuteTestFix: typeof _applyFixDeps.executeTestFix;

beforeEach(() => {
  origExecuteSourceFix = _applyFixDeps.executeSourceFix;
  origExecuteTestFix = _applyFixDeps.executeTestFix;
});

afterEach(() => {
  _applyFixDeps.executeSourceFix = origExecuteSourceFix;
  _applyFixDeps.executeTestFix = origExecuteTestFix;
});

describe("applyFix()", () => {
  test("source_bug verdict → calls executeSourceFix once", async () => {
    const sourceFixMock = mock(async () => ({ success: true, cost: 0.1 }));
    const testFixMock = mock(async () => ({ success: true, cost: 0.05 }));
    _applyFixDeps.executeSourceFix = sourceFixMock;
    _applyFixDeps.executeTestFix = testFixMock;

    const result = await applyFix({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      diagnosis: makeApplyFixDiagnosis("source_bug"),
    });

    expect(sourceFixMock).toHaveBeenCalledTimes(1);
    expect(testFixMock).not.toHaveBeenCalled();
    expect(result.cost).toBe(0.1);
  });

  test("test_bug verdict → calls executeTestFix once", async () => {
    const sourceFixMock = mock(async () => ({ success: true, cost: 0.1 }));
    const testFixMock = mock(async () => ({ success: true, cost: 0.05 }));
    _applyFixDeps.executeSourceFix = sourceFixMock;
    _applyFixDeps.executeTestFix = testFixMock;

    const result = await applyFix({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      diagnosis: makeApplyFixDiagnosis("test_bug"),
    });

    expect(testFixMock).toHaveBeenCalledTimes(1);
    expect(sourceFixMock).not.toHaveBeenCalled();
    expect(result.cost).toBe(0.05);
  });

  test("both verdict → calls executeSourceFix then executeTestFix", async () => {
    const callOrder: string[] = [];
    const sourceFixMock = mock(async () => {
      callOrder.push("source");
      return { success: true, cost: 0.1 };
    });
    const testFixMock = mock(async () => {
      callOrder.push("test");
      return { success: true, cost: 0.05 };
    });
    _applyFixDeps.executeSourceFix = sourceFixMock;
    _applyFixDeps.executeTestFix = testFixMock;

    const result = await applyFix({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      diagnosis: makeApplyFixDiagnosis("both"),
    });

    expect(callOrder).toEqual(["source", "test"]);
    expect(result.cost).toBeCloseTo(0.15, 6);
  });

  test("does not retry — calls fix functions exactly once regardless of failure", async () => {
    const sourceFixMock = mock(async () => ({ success: false, cost: 0.1 }));
    _applyFixDeps.executeSourceFix = sourceFixMock;

    await applyFix({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      diagnosis: makeApplyFixDiagnosis("source_bug"),
    });

    expect(sourceFixMock).toHaveBeenCalledTimes(1); // not retried even though failed
  });

  test("passes previousFailure to executeTestFix", async () => {
    const testFixMock = mock(async () => ({ success: true, cost: 0.05 }));
    _applyFixDeps.executeTestFix = testFixMock;

    await applyFix({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      diagnosis: makeApplyFixDiagnosis("test_bug"),
      previousFailure: "PREVIOUS_MARKER",
    });

    const callArgs = (testFixMock as unknown as { mock: { calls: Array<[unknown, { previousFailure?: string }]> } }).mock
      .calls;
    expect(callArgs[0]?.[1].previousFailure).toBe("PREVIOUS_MARKER");
  });

  test("returns { cost: 0 } when agent not found", async () => {
    const ctx = makeAcceptanceCtx();
    ctx.agentGetFn = mock(() => undefined);
    const result = await applyFix({
      ctx,
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      diagnosis: makeApplyFixDiagnosis("source_bug"),
    });
    expect(result.cost).toBe(0);
  });
});
