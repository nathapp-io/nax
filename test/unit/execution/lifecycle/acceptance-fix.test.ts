/**
 * Tests for src/execution/lifecycle/acceptance-fix.ts
 *
 * Covers:
 * - resolveAcceptanceDiagnosis fast paths (no LLM call)
 * - resolveAcceptanceDiagnosis slow path (callOp invoked)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeDiagnoseOutput, makeMockRuntime, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { SemanticVerdict } from "@/acceptance/types";
import type { NaxConfig } from "@/config/schema";
import { _diagnosisDeps, resolveAcceptanceDiagnosis } from "@/execution/lifecycle/acceptance-fix";
import type { AcceptanceLoopContext } from "@/execution/lifecycle/acceptance-loop";
import type { AcceptanceDiagnoseInput } from "@/operations/acceptance-diagnose";

function makeConfig(): NaxConfig {
  return makeNaxConfig({
    models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    agent: { protocol: "acp" },
  });
}

function makeAcceptanceCtx(withRuntime = false): AcceptanceLoopContext {
  // `withRuntime` is retained for readability at call sites (fast-path tests
  // never dereference `ctx.runtime`), but DispatchContext requires `runtime`
  // (and its `agentManager`/`sessionManager` siblings) unconditionally, so
  // both branches must supply a valid mock — sourced from ONE runtime so
  // `ctx.agentManager === ctx.runtime.agentManager`, as in production.
  const runtime = makeMockRuntime({ config: makeConfig() });
  void withRuntime;
  return {
    config: makeConfig(),
    prd: makePRD({ userStories: [makeStory({ id: "US-001", acceptanceCriteria: [] })] }),
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
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: new AbortController().signal,
    acceptanceTestPaths: [{ testPath: "/tmp/features/test/.nax-acceptance.test.ts", packageDir: "/tmp/workdir" }],
    runtime,
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

let savedCallOp: typeof _diagnosisDeps.callOp;

beforeEach(() => {
  savedCallOp = _diagnosisDeps.callOp;
});

afterEach(() => {
  _diagnosisDeps.callOp = savedCallOp;
  mock.restore();
});

// ─── resolveAcceptanceDiagnosis fast paths ───────────────────────────────────

describe("resolveAcceptanceDiagnosis() — fast paths", () => {
  test("implement-only strategy → source_bug, no callOp invoked", async () => {
    let callOpCalled = false;
    _diagnosisDeps.callOp = async () => {
      callOpCalled = true;
      return makeDiagnoseOutput({
        verdict: "source_bug",
        reasoning: "unreachable — fast path should not invoke callOp",
        confidence: 1,
      });
    };

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
    _diagnosisDeps.callOp = async () => {
      callOpCalled = true;
      return makeDiagnoseOutput({
        verdict: "source_bug",
        reasoning: "unreachable — fast path should not invoke callOp",
        confidence: 1,
      });
    };

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
    _diagnosisDeps.callOp = async () => {
      callOpCalled = true;
      return makeDiagnoseOutput({
        verdict: "source_bug",
        reasoning: "unreachable — fast path should not invoke callOp",
        confidence: 1,
      });
    };

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(),
      failures: {
        failedACs: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9"],
        testOutput: "fail",
      },
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
    _diagnosisDeps.callOp = async () => {
      callOpCalled = true;
      return makeDiagnoseOutput({
        verdict: "source_bug",
        reasoning: "unreachable — fast path should not invoke callOp",
        confidence: 1,
      });
    };

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
    _diagnosisDeps.callOp = async () => {
      callOpCalled = true;
      return makeDiagnoseOutput({ verdict: "source_bug", reasoning: "LLM diagnosis", confidence: 0.8 });
    };

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(true), // runtime required for slow path
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
    let capturedInput: AcceptanceDiagnoseInput | undefined;
    _diagnosisDeps.callOp = async (_callCtx, _op, input) => {
      capturedInput = input;
      return makeDiagnoseOutput({ verdict: "source_bug", reasoning: "LLM diagnosis", confidence: 0.8 });
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
