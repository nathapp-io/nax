/**
 * Unit tests for run-regression.ts — deferred regression gate early-exit logic.
 *
 * Key behaviours tested:
 * - Full suite passes on initial run → return immediately, no rectification
 * - First story fixes all failures → early exit after mid-loop re-run (storiesSkipped > 0)
 * - First story partial fix, second story fixes rest → early exit after second story
 * - No story fixes anything → falls through to final re-run
 * - currentTestOutput is forwarded to each story's rectification (not stale initial output)
 * - storyCosts is populated with per-story agent cost from rectification (issue #679)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeMockRuntime, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { DeferredRegressionOptions } from "@/execution";
import { _regressionDeps, runDeferredRegression } from "@/execution";
import type { Finding, FixCycleResult } from "@/findings";
import type { PRD } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import type { FlakeTriageInput, FlakeTriageResult, VerificationResult } from "@/verification";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeVerifyResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    success: false,
    status: "TEST_FAILURE",
    countsTowardEscalation: true,
    output: "92 fail | 0 pass\n(fail) some test",
    passCount: 0,
    failCount: 92,
    ...overrides,
  };
}

function makePassResult(passCount = 150): VerificationResult {
  return {
    success: true,
    status: "SUCCESS",
    countsTowardEscalation: false,
    output: `${passCount} pass | 0 fail`,
    passCount,
    failCount: 0,
  };
}

function makeFixCycleResult(succeeded: boolean, costUsd = 0, iterationCount = 1): FixCycleResult<Finding> {
  if (succeeded) {
    return {
      iterations: Array.from({ length: iterationCount }, (_, i) => ({
        iterationNum: i + 1,
        findingsBefore: [],
        fixesApplied: [],
        findingsAfter: [],
        outcome: "resolved" as const,
        startedAt: "",
        finishedAt: "",
      })),
      finalFindings: [],
      exitReason: "resolved",
      costUsd,
    };
  }
  const finding: Finding = {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "t",
    message: "fail",
    fixTarget: "source",
  };
  return {
    iterations: Array.from({ length: iterationCount }, (_, i) => ({
      iterationNum: i + 1,
      findingsBefore: [finding],
      fixesApplied: [],
      findingsAfter: [finding],
      outcome: "unchanged" as const,
      startedAt: "",
      finishedAt: "",
    })),
    finalFindings: [finding],
    exitReason: "max-attempts-total",
    costUsd,
  };
}

function makeConfig(): NaxConfig {
  return makeNaxConfig({
    quality: {
      commands: { test: "bun test" },
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 0,
      gracePeriodMs: 0,
      drainTimeoutMs: 0,
      stripEnvVars: [],
    },
    execution: {
      regressionGate: {
        mode: "deferred",
        timeoutSeconds: 60,
        acceptOnTimeout: true,
      },
    },
  });
}

function makePrd(storyIds: string[]): PRD {
  return makePRD({
    userStories: storyIds.map((id) => makeStory({ id, title: id, status: "passed" })),
  });
}

function failuresFor(storyIds: string[]) {
  return storyIds.map((storyId) => ({
    file: `${storyId}.test.ts`,
    testName: `${storyId} regression`,
    error: "boom",
    stackTrace: [],
  }));
}

function makeOptions(storyIds: string[], runtimeOverride?: NaxRuntime): DeferredRegressionOptions {
  return {
    config: makeConfig(),
    prd: makePrd(storyIds),
    workdir: "/tmp/test-workdir",
    runtime: runtimeOverride ?? makeMockRuntime(),
    storyMetrics: storyIds.map((storyId, index) => ({
      storyId,
      completedAt: new Date(index * 1_000).toISOString(),
      failingTestFiles: [`${storyId}.test.ts`],
    })),
  };
}

// Save/restore pattern — no mock.module() to avoid Bun 1.x global leaks
let savedDeps: typeof _regressionDeps;
beforeEach(() => {
  savedDeps = { ..._regressionDeps };
  // Default triage stub — pass findings through unchanged, no quarantine.
  // These tests don't exercise triage behaviour; using a no-op stub isolates
  // them from the real triage implementation (which would otherwise invoke
  // a probe loop in the test environment).
  _regressionDeps.triageFlakyFindings = async (input: FlakeTriageInput): Promise<FlakeTriageResult> => ({
    findings: input.findings.map((f) => ({ ...f })),
    quarantineReport: { keys: [], reasons: [] },
  });
});
afterEach(() => {
  Object.assign(_regressionDeps, savedDeps);
});

// ─────────────────────────────────────────────────────────────────────────────
// Baseline: initial full suite passes
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — initial suite passes", () => {
  test("returns success immediately without rectification", async () => {
    const verifyCallCount = { n: 0 };
    _regressionDeps.runVerification = mock(async () => {
      verifyCallCount.n++;
      return makePassResult();
    });
    _regressionDeps.runFixCycle = mock(async () => makeFixCycleResult(false));
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 150, failed: 0, failures: [] }));
    const result = await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(0);
    // Only the initial suite run — no mid-loop or final re-run
    expect(verifyCallCount.n).toBe(1);
    // No rectification ran, so no costs
    expect(result.storyCosts).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Early exit: first story fixes everything
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — early exit after first story", () => {
  test("stops after first story when mid-loop re-run passes", async () => {
    const verifyCalls: string[] = [];

    _regressionDeps.runVerification = mock(async () => {
      const call = verifyCalls.length;
      verifyCalls.push(`call-${call}`);
      // call 0: initial suite — fail
      if (call === 0) return makeVerifyResult();
      // call 1: mid-loop after US-001 — pass (early exit)
      return makePassResult(150);
    });

    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 92,
      failures: failuresFor(["US-001", "US-002", "US-003"]),
    }));
    const rectifiedStories: string[] = [];
    _regressionDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      rectifiedStories.push(cycleCtx.storyId);
      return makeFixCycleResult(true, 0.5); // fixed on first attempt
    });

    const result = await runDeferredRegression(makeOptions(["US-001", "US-002", "US-003"]));

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(150);
    // Only US-001 was rectified — early exit skipped US-002 and US-003
    expect(rectifiedStories).toEqual(["US-001"]);
    // verify called twice: initial + mid-loop after US-001 (no final re-run)
    expect(verifyCalls).toHaveLength(2);
    expect(result.rectificationAttempts).toBe(1);
    // Cost is tracked for the story that ran
    expect(result.storyCosts).toEqual({ "US-001": 0.5 });
  });

  test("count-only failures remain unresolved instead of rectifying every passed story", async () => {
    const verifyCalls: string[] = [];

    _regressionDeps.runVerification = mock(async () => {
      const call = verifyCalls.length;
      verifyCalls.push(`call-${call}`);
      if (call === 0) {
        return makeVerifyResult({
          output: "3 passed, 2 failed [1.7ms]\nsrc/foo.ts:12:8 - error TS2304: Cannot find name 'missingSymbol'",
          passCount: 3,
          failCount: 2,
        });
      }
      return makePassResult(151);
    });

    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 3,
      failed: 2,
      failures: [],
    }));

    const rectifiedStories: string[] = [];
    _regressionDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      rectifiedStories.push(cycleCtx.storyId);
      return makeFixCycleResult(true, 0.4);
    });

    const result = await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    expect(result.success).toBe(false);
    expect(result.affectedStories).toEqual([]);
    expect(rectifiedStories).toEqual([]);
    expect(result.rectificationAttempts).toBe(0);
    expect(verifyCalls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blind-rectifier guard: empty structured failures must not no-op as "resolved"
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — synthetic finding when no structured failures parsed", () => {
  test("feeds the fix cycle a non-empty finding so it cannot short-circuit to resolved", async () => {
    const verifyCalls: string[] = [];
    _regressionDeps.runVerification = mock(async () => {
      const call = verifyCalls.length;
      verifyCalls.push(`call-${call}`);
      // initial: suite fails (non-zero exit) but only a count is parseable, no
      // structured failures — a downstream "230 passed, 10 errors" shape.
      if (call === 0) {
        return makeVerifyResult({
          output: "======================== 230 passed, 10 errors in 5.29s ========================",
          passCount: 230,
          failCount: 0,
        });
      }
      return makePassResult(230);
    });

    let parseCallCount = 0;
    _regressionDeps.parseTestOutput = mock(() => {
      parseCallCount++;
      return parseCallCount === 1
        ? { passed: 230, failed: 1, failures: failuresFor(["US-001"]) }
        : { passed: 230, failed: 0, failures: [] };
    });

    let capturedFindingCount = -1;
    _regressionDeps.runFixCycle = mock(async (cycle, cycleCtx) => {
      capturedFindingCount = cycle.findings.length;
      // sanity: the synthetic finding must be one the rectify strategy applies to
      expect(cycle.findings[0]?.source).toBe("test-runner");
      void cycleCtx;
      return makeFixCycleResult(true, 0.1);
    });

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    // Before the fix this was 0 → runFixCycle would short-circuit to "resolved"
    // without ever invoking the agent, falsely reporting a successful fix.
    expect(capturedFindingCount).toBeGreaterThan(0);
    expect(result.rectificationAttempts).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Early exit: second story fixes the rest
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — early exit after second story", () => {
  test("continues to second story when first mid-loop still fails, exits after second", async () => {
    const verifyCalls: string[] = [];

    _regressionDeps.runVerification = mock(async () => {
      const call = verifyCalls.length;
      verifyCalls.push(`call-${call}`);
      if (call === 0) return makeVerifyResult(); // initial: fail
      if (call === 1) return makeVerifyResult(); // mid-loop after US-001: still fail
      return makePassResult(100); // mid-loop after US-002: pass → early exit
    });

    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 92,
      failures: failuresFor(["US-001", "US-002", "US-003"]),
    }));
    const rectifiedStories: string[] = [];
    _regressionDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      rectifiedStories.push(cycleCtx.storyId);
      return makeFixCycleResult(true, 0.3); // each story claims it fixed things
    });

    const result = await runDeferredRegression(makeOptions(["US-001", "US-002", "US-003"]));

    expect(result.success).toBe(true);
    expect(rectifiedStories).toEqual(["US-001", "US-002"]);
    // verify: initial + mid after US-001 + mid after US-002
    expect(verifyCalls).toHaveLength(3);
    // US-003 was never rectified
    expect(rectifiedStories).not.toContain("US-003");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No early exit: no story fixes anything → final re-run
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — no story fixes anything", () => {
  test("falls through to final re-run when rectification never succeeds", async () => {
    const verifyCalls: string[] = [];

    _regressionDeps.runVerification = mock(async () => {
      verifyCalls.push(`call-${verifyCalls.length}`);
      return makeVerifyResult(); // always fail
    });

    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 92,
      failures: failuresFor(["US-001", "US-002"]),
    }));
    _regressionDeps.runFixCycle = mock(async () => makeFixCycleResult(false)); // never fixed

    const result = await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    expect(result.success).toBe(false);
    // initial + final re-run only (no mid-loop since rectification never succeeded)
    expect(verifyCalls).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// currentTestOutput forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — test output context forwarding", () => {
  test("passes updated test output from mid-loop to next story's rectification", async () => {
    const capturedParseArgs: string[] = [];
    let verifyCallIndex = 0;

    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return makeVerifyResult({ output: "INITIAL_FAIL_OUTPUT" });
      if (i === 1) {
        // mid-loop after US-001 — still failing, updated output
        return makeVerifyResult({ output: "UPDATED_FAIL_OUTPUT" });
      }
      return makePassResult(); // mid-loop after US-002 → early exit
    });

    const parseTestOutput: typeof _regressionDeps.parseTestOutput = (output) => {
      capturedParseArgs.push(output);
      return { passed: 0, failed: 92, failures: failuresFor(["US-001", "US-002"]) };
    };
    _regressionDeps.parseTestOutput = parseTestOutput;
    _regressionDeps.runFixCycle = mock(async () => makeFixCycleResult(true, 0.1));

    await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    // capturedParseArgs[0] = initial testSummary from fullSuiteResult.output
    // capturedParseArgs[1] = US-001 initialFindings (uses initial currentTestOutput)
    // capturedParseArgs[2] = US-002 initialFindings (uses updated currentTestOutput after mid-loop)
    expect(capturedParseArgs[1]).toBe("INITIAL_FAIL_OUTPUT");
    expect(capturedParseArgs[2]).toBe("UPDATED_FAIL_OUTPUT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disabled / non-deferred mode
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — mode gating", () => {
  test("returns success immediately when mode is disabled", async () => {
    const config = makeConfig();
    (config.execution.regressionGate as { mode: string }).mode = "disabled";

    _regressionDeps.runVerification = mock(async () => makeVerifyResult());

    const result = await runDeferredRegression({
      config,
      prd: makePrd(["US-001"]),
      workdir: "/tmp/test",
      runtime: makeMockRuntime(),
    });

    expect(result.success).toBe(true);
    expect(_regressionDeps.runVerification).not.toHaveBeenCalled();
    expect(result.storyCosts).toEqual({});
  });

  test("runs the deferred suite when mode is per-story (superset of deferred)", async () => {
    const config = makeConfig();
    (config.execution.regressionGate as { mode: string }).mode = "per-story";

    _regressionDeps.runVerification = mock(async () => makePassResult());
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 150, failed: 0, failures: [] }));

    const result = await runDeferredRegression({
      config,
      prd: makePrd(["US-001"]),
      workdir: "/tmp/test",
      runtime: makeMockRuntime(),
    });

    expect(result.success).toBe(true);
    // per-story no longer short-circuits — the full suite is actually run.
    expect(_regressionDeps.runVerification).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// storyCosts accumulation — issue #679
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — storyCosts tracking (issue #679)", () => {
  test("accumulates cost per story across rectification attempts", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return makeVerifyResult(); // initial: fail
      return makePassResult(); // mid-loop after first story: pass
    });
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 5, failures: failuresFor(["US-001"]) }));
    _regressionDeps.runFixCycle = mock(async () => makeFixCycleResult(true, 1.2559));

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    expect(result.success).toBe(true);
    expect(result.storyCosts?.["US-001"]).toBeCloseTo(1.2559);
  });

  test("accumulates cost for the cycle even when not succeeded", async () => {
    // US-001 cycle fails (maxRectificationAttempts = 2, handled inside runFixCycle)
    // Then the final re-run passes
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: failuresFor(["US-001"]) }));
    _regressionDeps.runFixCycle = mock(async () => makeFixCycleResult(false, 1.5, 2));

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    // 2 iteration cycle × $0.75 each = $1.5 total cost
    expect(result.storyCosts?.["US-001"]).toBeCloseTo(1.5);
    // 2 iterations counted as rectificationAttempts
    expect(result.rectificationAttempts).toBe(2);
  });

  test("tracks cost for each affected story independently", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return makeVerifyResult(); // initial: fail
      if (i === 1) return makeVerifyResult(); // mid after US-001: still fail
      return makePassResult(); // mid after US-002: pass
    });
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 3,
      failures: failuresFor(["US-001", "US-002"]),
    }));
    let storyIdx = 0;
    _regressionDeps.runFixCycle = mock(async () => {
      storyIdx++;
      return makeFixCycleResult(true, storyIdx === 1 ? 0.4 : 0.6);
    });

    const result = await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    expect(result.success).toBe(true);
    expect(result.storyCosts?.["US-001"]).toBeCloseTo(0.4);
    expect(result.storyCosts?.["US-002"]).toBeCloseTo(0.6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// storyDurations + storyOutcomes — follow-up to #679
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — storyDurations + storyOutcomes", () => {
  test("storyDurations is a non-negative number per story", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: failuresFor(["US-001"]) }));
    _regressionDeps.runFixCycle = mock(async () => makeFixCycleResult(false, 0.2, 2));

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    expect(typeof result.storyDurations?.["US-001"]).toBe("number");
    expect(result.storyDurations?.["US-001"]).toBeGreaterThanOrEqual(0);
  });

  test("storyOutcomes reflects per-story rectification success rather than the overall result", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return makeVerifyResult(); // initial: fail
      if (i === 1) return makeVerifyResult(); // mid after US-001: still fail
      return makeVerifyResult(); // final re-run: still fail
    });
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 3,
      failures: failuresFor(["US-001", "US-002"]),
    }));
    let storyIdx = 0;
    _regressionDeps.runFixCycle = mock(async () => {
      storyIdx++;
      // First story "succeeds" locally but the overall suite still fails; second story fails.
      return storyIdx === 1 ? makeFixCycleResult(true, 0.4) : makeFixCycleResult(false, 0.5);
    });

    const result = await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    expect(result.success).toBe(false); // overall still failing
    expect(result.storyOutcomes?.["US-001"]).toBe(true);
    expect(result.storyOutcomes?.["US-002"]).toBe(false);
  });

  test("storyOutcomes latches true once any cycle succeeds", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: failuresFor(["US-001"]) }));
    _regressionDeps.runFixCycle = mock(async () => makeFixCycleResult(true, 0.3));

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    expect(result.storyOutcomes?.["US-001"]).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3/AC4: TypeScript type guards — runtime required, agentManager not a substitute
//
// These @ts-expect-error annotations are RED before implementation:
//   - Before impl: `agentManager` satisfies the old interface (no TS error on the line)
//     → @ts-expect-error is UNUSED → typecheck fails with "Unused @ts-expect-error"
//   - After impl: `runtime` is required and missing → TS error on the line
//     → @ts-expect-error correctly suppresses it → typecheck passes
// ─────────────────────────────────────────────────────────────────────────────

// AC4: runtime is required even when agentManager is present
const _ac4TypeCheck: DeferredRegressionOptions = {
  config: {} as NaxConfig,
  prd: {} as PRD,
  workdir: "/tmp",
  // @ts-expect-error — agentManager is not a substitute for the required runtime
  // field. The directive sits on the property, not the declaration: TS reports the
  // excess-property error at `agentManager`, so anchoring it above `const` left it
  // unused while the real error went unsuppressed.
  agentManager: {} as import("@/agents").IAgentManager,
};
void _ac4TypeCheck;

// ─────────────────────────────────────────────────────────────────────────────
// AC5: runDeferredRegression reads agentManager from runtime.agentManager
// AC6: runDeferredRegression passes runtime to runFixCycle
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — runtime threading (AC5/AC6)", () => {
  test("AC5: passes runtime.agentManager to cycleCtx (not a separate agentManager)", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return makeVerifyResult(); // initial: fail
      return makePassResult(); // mid-loop: pass → early exit
    });
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: failuresFor(["US-001"]) }));

    let capturedAgentManager: unknown;
    _regressionDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      capturedAgentManager = cycleCtx.runtime.agentManager;
      return makeFixCycleResult(true, 0.1);
    });

    const { makeMockAgentManager: makeAM } = await import("@test/helpers");
    const specificAgentManager = makeAM();
    const mockRuntime = makeMockRuntime({ agentManager: specificAgentManager });

    await runDeferredRegression(makeOptions(["US-001"], mockRuntime));

    // AC5: agentManager in cycleCtx comes from runtime.agentManager, not a separate field
    expect(capturedAgentManager).toBe(specificAgentManager);
  });

  test("AC6: passes runtime to cycleCtx.runtime", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return makeVerifyResult();
      return makePassResult();
    });
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: failuresFor(["US-001"]) }));

    let capturedRuntime: unknown;
    _regressionDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      capturedRuntime = cycleCtx.runtime;
      return makeFixCycleResult(true, 0.1);
    });

    const mockRuntime = makeMockRuntime();
    await runDeferredRegression(makeOptions(["US-001"], mockRuntime));

    // AC6: runtime is passed through to cycleCtx
    expect(capturedRuntime).toBe(mockRuntime);
  });
});
