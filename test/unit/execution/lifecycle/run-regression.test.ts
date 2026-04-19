/**
 * Unit tests for run-regression.ts — deferred regression gate early-exit logic.
 *
 * Key behaviours tested:
 * - Full suite passes on initial run → return immediately, no rectification
 * - First story fixes all failures → early exit after mid-loop re-run (storiesSkipped > 0)
 * - First story partial fix, second story fixes rest → early exit after second story
 * - No story fixes anything → falls through to final re-run
 * - currentTestOutput is forwarded to each story's rectification (not stale initial output)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _regressionDeps, runDeferredRegression } from "../../../../src/execution/lifecycle/run-regression";
import type { DeferredRegressionOptions } from "../../../../src/execution/lifecycle/run-regression";
import type { NaxConfig } from "../../../../src/config";
import type { PRD } from "../../../../src/prd";
import type { VerificationResult } from "../../../../src/verification/types";

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

function makeConfig(): NaxConfig {
  return {
    quality: {
      commands: { test: "bun test" },
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 0,
      gracePeriodMs: 0,
      drainTimeoutMs: 0,
      shell: false,
      stripEnvVars: [],
    },
    execution: {
      regressionGate: {
        mode: "deferred",
        timeoutSeconds: 60,
        maxRectificationAttempts: 2,
        acceptOnTimeout: true,
      },
    },
  } as unknown as NaxConfig;
}

function makePrd(storyIds: string[]): PRD {
  return {
    userStories: storyIds.map((id) => ({ id, status: "passed", title: id })),
  } as unknown as PRD;
}

function makeOptions(storyIds: string[]): DeferredRegressionOptions {
  return {
    config: makeConfig(),
    prd: makePrd(storyIds),
    workdir: "/tmp/test-workdir",
  };
}

// Save/restore pattern — no mock.module() to avoid Bun 1.x global leaks
let savedDeps: typeof _regressionDeps;
beforeEach(() => {
  savedDeps = { ..._regressionDeps };
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
    _regressionDeps.runRectificationLoop = mock(async () => false);
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 150, failed: 0, failures: [] }));
    const result = await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(0);
    // Only the initial suite run — no mid-loop or final re-run
    expect(verifyCallCount.n).toBe(1);
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
      failures: [], // unmapped → all stories affected
    }));
    const rectifiedStories: string[] = [];
    _regressionDeps.runRectificationLoop = mock(async (opts) => {
      rectifiedStories.push(opts.story.id);
      return true; // fixed on first attempt
    });

    const result = await runDeferredRegression(makeOptions(["US-001", "US-002", "US-003"]));

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(150);
    // Only US-001 was rectified — early exit skipped US-002 and US-003
    expect(rectifiedStories).toEqual(["US-001"]);
    // verify called twice: initial + mid-loop after US-001 (no final re-run)
    expect(verifyCalls).toHaveLength(2);
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
      if (call === 0) return makeVerifyResult();          // initial: fail
      if (call === 1) return makeVerifyResult();          // mid-loop after US-001: still fail
      return makePassResult(100);                          // mid-loop after US-002: pass → early exit
    });

    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 92,
      failures: [],
    }));
    const rectifiedStories: string[] = [];
    _regressionDeps.runRectificationLoop = mock(async (opts) => {
      rectifiedStories.push(opts.story.id);
      return true; // each story claims it fixed things
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
      failures: [],
    }));
    _regressionDeps.runRectificationLoop = mock(async () => false); // never fixed

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
    const capturedOutputs: string[] = [];
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

    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 92,
      failures: [],
    }));
    _regressionDeps.runRectificationLoop = mock(async (opts) => {
      capturedOutputs.push(opts.testOutput);
      return true;
    });

    await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    // US-001 receives the initial output
    expect(capturedOutputs[0]).toBe("INITIAL_FAIL_OUTPUT");
    // US-002 receives the updated output from mid-loop re-run
    expect(capturedOutputs[1]).toBe("UPDATED_FAIL_OUTPUT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disabled / non-deferred mode
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredRegression — disabled mode", () => {
  test("returns success immediately when mode is disabled", async () => {
    const config = makeConfig();
    (config.execution.regressionGate as { mode: string }).mode = "disabled";

    _regressionDeps.runVerification = mock(async () => makeVerifyResult());

    const result = await runDeferredRegression({
      config,
      prd: makePrd(["US-001"]),
      workdir: "/tmp/test",
    });

    expect(result.success).toBe(true);
    expect(_regressionDeps.runVerification).not.toHaveBeenCalled();
  });
});
