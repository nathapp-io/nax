/**
 * Tests for src/execution/lifecycle/acceptance-fix.ts
 *
 * Covers:
 * - resolveAcceptanceDiagnosis fast paths (no LLM call)
 * - resolveAcceptanceDiagnosis slow path (callOp invoked)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _applyFixDeps,
  resolveAcceptanceDiagnosis,
} from "../../../../src/execution/lifecycle/acceptance-fix";
import type { SemanticVerdict } from "../../../../src/acceptance/types";
import type { NaxConfig } from "../../../../src/config/schema";
import type { AcceptanceLoopContext } from "../../../../src/execution/lifecycle/acceptance-loop";
import { makeNaxConfig } from "../../../helpers";

function makeConfig(): NaxConfig {
  return makeNaxConfig({
    models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    agent: { protocol: "acp" },
  });
}

function makeMockRuntime() {
  return {
    packages: {
      resolve: () => ({ select: () => ({}) }),
      all: () => [],
      repo: () => ({ select: () => ({}) }),
    },
    agentManager: { getDefault: () => "claude" },
    configLoader: { current: () => makeConfig() },
    sessionManager: { nameFor: () => "session", runInSession: mock(async () => ({ output: "" })) },
    signal: undefined,
  } as unknown as AcceptanceLoopContext["runtime"];
}

function makeAcceptanceCtx(withRuntime = false): AcceptanceLoopContext {
  return {
    config: makeConfig(),
    prd: { userStories: [{ id: "US-001", acceptanceCriteria: [] }] } as unknown as AcceptanceLoopContext["prd"],
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
    agentManager: { getDefault: () => "claude" } as unknown as AcceptanceLoopContext["agentManager"],
    acceptanceTestPaths: [{ testPath: "/tmp/features/test/.nax-acceptance.test.ts", packageDir: "/tmp/workdir" }],
    runtime: withRuntime ? makeMockRuntime() : undefined,
  };
}

function makeDiagnosisOpts() {
  return {
    testOutput: "(fail) AC-1: failed",
    testFileContent: "test('AC-1', () => {});",
    workdir: "/tmp/workdir",
    storyId: "US-001",
  };
}

let savedCallOp: typeof _applyFixDeps.callOp;

beforeEach(() => {
  savedCallOp = _applyFixDeps.callOp;
});

afterEach(() => {
  _applyFixDeps.callOp = savedCallOp;
  mock.restore();
});

// ─── resolveAcceptanceDiagnosis fast paths ───────────────────────────────────

describe("resolveAcceptanceDiagnosis() — fast paths", () => {
  test("implement-only strategy → source_bug, no callOp invoked", async () => {
    let callOpCalled = false;
    _applyFixDeps.callOp = async () => { callOpCalled = true; return {} as any; };

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      totalACs: 10,
      strategy: "implement-only",
      semanticVerdicts: [],
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(result.verdict).toBe("source_bug");
    expect(result.confidence).toBe(1.0);
    expect(callOpCalled).toBe(false);
  });

  test("all semantic verdicts passed → test_bug, no callOp invoked", async () => {
    let callOpCalled = false;
    _applyFixDeps.callOp = async () => { callOpCalled = true; return {} as any; };

    const verdicts: SemanticVerdict[] = [
      { storyId: "US-001", passed: true, timestamp: "2026-01-01T00:00:00Z", acCount: 5, findings: [] },
      { storyId: "US-002", passed: true, timestamp: "2026-01-01T00:00:00Z", acCount: 3, findings: [] },
    ];
    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: verdicts,
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(result.verdict).toBe("test_bug");
    expect(result.confidence).toBe(1.0);
    expect(result.reasoning).toContain("Semantic review confirmed");
    expect(callOpCalled).toBe(false);
  });

  test(">80% ACs failed → test_bug, no callOp invoked", async () => {
    let callOpCalled = false;
    _applyFixDeps.callOp = async () => { callOpCalled = true; return {} as any; };

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9"], testOutput: "fail" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: [],
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(result.verdict).toBe("test_bug");
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toContain("Test-level failure");
    expect(callOpCalled).toBe(false);
  });

  test("AC-ERROR sentinel → test_bug, no callOp invoked", async () => {
    let callOpCalled = false;
    _applyFixDeps.callOp = async () => { callOpCalled = true; return {} as any; };

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-ERROR"], testOutput: "test crashed" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: [],
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(result.verdict).toBe("test_bug");
    expect(callOpCalled).toBe(false);
  });

  test("normal failure (no fast path) → callOp invoked", async () => {
    let callOpCalled = false;
    _applyFixDeps.callOp = async (_callCtx, _op, _input) => {
      callOpCalled = true;
      return { verdict: "source_bug", reasoning: "LLM diagnosis", confidence: 0.8 } as any;
    };

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(true),  // runtime required for slow path
      failures: { failedACs: ["AC-1", "AC-2"], testOutput: "(fail) AC-1\n(fail) AC-2" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts: [
        { storyId: "US-001", passed: false, timestamp: "2026-01-01T00:00:00Z", acCount: 5, findings: [] },
      ],
      diagnosisOpts: makeDiagnosisOpts(),
    });
    expect(callOpCalled).toBe(true);
    expect(result.verdict).toBe("source_bug");
  });

  test("normal path passes semanticVerdicts to callOp input", async () => {
    let capturedInput: any;
    _applyFixDeps.callOp = async (_callCtx, _op, input) => {
      capturedInput = input;
      return { verdict: "source_bug", reasoning: "LLM diagnosis", confidence: 0.8 } as any;
    };

    const semanticVerdicts: SemanticVerdict[] = [
      { storyId: "US-001", passed: false, timestamp: "2026-01-01T00:00:00Z", acCount: 2, findings: [] },
    ];

    await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(true),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      totalACs: 10,
      strategy: "diagnose-first",
      semanticVerdicts,
      diagnosisOpts: makeDiagnosisOpts(),
    });

    expect(capturedInput?.semanticVerdicts).toEqual(semanticVerdicts);
  });
});
