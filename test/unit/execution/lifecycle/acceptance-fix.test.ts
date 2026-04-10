/**
 * Tests for src/execution/lifecycle/acceptance-fix.ts
 *
 * Covers US-004: resolveAcceptanceDiagnosis fast paths
 */

import { describe, expect, mock, test } from "bun:test";
import { resolveAcceptanceDiagnosis } from "../../../../src/execution/lifecycle/acceptance-fix";
import type { DiagnoseOptions } from "../../../../src/acceptance/fix-diagnosis";
import type { SemanticVerdict } from "../../../../src/acceptance/types";
import type { AgentAdapter } from "../../../../src/agents/types";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { NaxConfig } from "../../../../src/config/schema";

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
