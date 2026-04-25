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
import type { NaxConfig } from "../../../../src/config";
import { _regressionDeps, runDeferredRegression } from "../../../../src/execution/lifecycle/run-regression";
import type { DeferredRegressionOptions } from "../../../../src/execution/lifecycle/run-regression";
import type { PRD } from "../../../../src/prd";
import type { VerificationResult } from "../../../../src/verification/types";
import { makeNaxConfig } from "../../../helpers";

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
  return makeNaxConfig({
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
  });
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
    _regressionDeps.runRectificationLoop = mock(async () => ({ succeeded: false, cost: 0, durationMs: 0 }));
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
      failures: [], // unmapped → all stories affected
    }));
    const rectifiedStories: string[] = [];
    _regressionDeps.runRectificationLoop = mock(async (opts) => {
      rectifiedStories.push(opts.story.id);
      return { succeeded: true, cost: 0.5, durationMs: 200 }; // fixed on first attempt
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
      failures: [],
    }));
    const rectifiedStories: string[] = [];
    _regressionDeps.runRectificationLoop = mock(async (opts) => {
      rectifiedStories.push(opts.story.id);
      return { succeeded: true, cost: 0.3, durationMs: 150 }; // each story claims it fixed things
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
    _regressionDeps.runRectificationLoop = mock(async () => ({ succeeded: false, cost: 0, durationMs: 0 })); // never fixed

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
      return { succeeded: true, cost: 0.1, durationMs: 75 };
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
    expect(result.storyCosts).toEqual({});
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
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 5, failures: [] }));
    _regressionDeps.runRectificationLoop = mock(async () => ({ succeeded: true, cost: 1.2559, durationMs: 500 }));

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    expect(result.success).toBe(true);
    expect(result.storyCosts?.["US-001"]).toBeCloseTo(1.2559);
  });

  test("accumulates cost for multiple attempts on the same story when no early exit fires", async () => {
    // US-001 fails to fix in attempt 1, retries (maxRectificationAttempts = 2)
    // Then the final re-run passes
    let rectifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: [] }));
    _regressionDeps.runRectificationLoop = mock(async () => {
      rectifyCallIndex++;
      // Never claim succeeded so there's no mid-loop verify call and we fall through
      return { succeeded: false, cost: 0.75, durationMs: 120 };
    });

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    // 2 attempts × $0.75 each — cost accumulated even when failed
    expect(result.storyCosts?.["US-001"]).toBeCloseTo(1.5);
    expect(rectifyCallIndex).toBe(2); // maxRectificationAttempts = 2
  });

  test("tracks cost for each affected story independently", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return makeVerifyResult(); // initial: fail
      if (i === 1) return makeVerifyResult(); // mid after US-001: still fail
      return makePassResult(); // mid after US-002: pass
    });
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: [] }));
    let storyIdx = 0;
    _regressionDeps.runRectificationLoop = mock(async () => {
      storyIdx++;
      return { succeeded: true, cost: storyIdx === 1 ? 0.4 : 0.6, durationMs: storyIdx === 1 ? 90 : 110 };
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
  test("accumulates wall-clock duration per story across rectification attempts", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: [] }));
    _regressionDeps.runRectificationLoop = mock(async () => ({
      succeeded: false,
      cost: 0.2,
      durationMs: 175,
    }));

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    // 2 attempts × 175 ms
    expect(result.storyDurations?.["US-001"]).toBe(350);
  });

  test("storyOutcomes reflects per-story rectification success rather than the overall result", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return makeVerifyResult(); // initial: fail
      if (i === 1) return makeVerifyResult(); // mid after US-001: still fail
      return makeVerifyResult(); // final re-run: still fail
    });
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: [] }));
    let storyIdx = 0;
    _regressionDeps.runRectificationLoop = mock(async () => {
      storyIdx++;
      // First story "succeeds" locally but the overall suite still fails; second story fails.
      return storyIdx === 1
        ? { succeeded: true, cost: 0.4, durationMs: 80 }
        : { succeeded: false, cost: 0.5, durationMs: 120 };
    });

    const result = await runDeferredRegression(makeOptions(["US-001", "US-002"]));

    expect(result.success).toBe(false); // overall still failing
    expect(result.storyOutcomes?.["US-001"]).toBe(true);
    expect(result.storyOutcomes?.["US-002"]).toBe(false);
  });

  test("storyOutcomes latches true once any attempt succeeds", async () => {
    _regressionDeps.runVerification = mock(async () => makeVerifyResult());
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 3, failures: [] }));
    let attempt = 0;
    _regressionDeps.runRectificationLoop = mock(async () => {
      attempt++;
      // First attempt succeeds; early-exit triggers before second attempt.
      return attempt === 1
        ? { succeeded: true, cost: 0.3, durationMs: 100 }
        : { succeeded: false, cost: 0.3, durationMs: 100 };
    });

    const result = await runDeferredRegression(makeOptions(["US-001"]));

    expect(result.storyOutcomes?.["US-001"]).toBe(true);
  });
});
