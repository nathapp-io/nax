/**
 * Execution Lifecycle Tests — runDeferredRegression
 *
 * Tests for deferred regression execution logic.
 * Extracted from lifecycle.test.ts for size management.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd";
import type { StoryMetrics } from "../../../src/metrics";
import {
  _regressionDeps,
  runDeferredRegression,
} from "../../../src/execution/lifecycle/run-regression";
import type { VerificationResult } from "../../../src/verification";
import { makeNaxConfig } from "../../helpers";

const WORKDIR_DISABLED = `/tmp/nax-test-disabled-${randomUUID()}`;
const WORKDIR_PER_STORY = `/tmp/nax-test-per-story-${randomUUID()}`;
const WORKDIR_NO_PASSED = `/tmp/nax-test-no-passed-${randomUUID()}`;
const WORKDIR_SHAPE = `/tmp/nax-test-shape-${randomUUID()}`;
const WORKDIR_STORY_IDS = `/tmp/nax-test-story-ids-${randomUUID()}`;
const WORKDIR_COUNTS = `/tmp/nax-test-counts-${randomUUID()}`;
const WORKDIR_BEHAVIORAL = `/tmp/nax-test-behavioral-${randomUUID()}`;
const WORKDIR_TIMEOUT_ACCEPT = `/tmp/nax-test-timeout-accept-${randomUUID()}`;
const WORKDIR_TIMEOUT_REJECT = `/tmp/nax-test-timeout-reject-${randomUUID()}`;
const WORKDIR_NO_OUTPUT = `/tmp/nax-test-no-output-${randomUUID()}`;
const WORKDIR_UNMAPPED = `/tmp/nax-test-unmapped-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makePRD(stories: Array<{ id: string; status: UserStory["status"] }>): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories.map(({ id, status }) => makeStory(id, status)),
  };
}

function makeConfig(
  regressionMode?: "deferred" | "per-story" | "disabled",
  testCommand?: string,
): NaxConfig {
  return makeNaxConfig({
    execution: {
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        ...(regressionMode !== undefined ? { mode: regressionMode } : {}),
        maxRectificationAttempts: 2,
      },
    },
    quality: {
      commands: {
        ...(testCommand ? { test: testCommand } : {}),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// runDeferredRegression tests
// ---------------------------------------------------------------------------

describe.skip("runDeferredRegression", () => {
  test("returns success immediately when mode is 'disabled'", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_DISABLED,
    });

    expect(result.success).toBe(true);
    expect(result.failedTests).toBe(0);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("returns success immediately when mode is 'per-story' (deferred not applicable)", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("per-story", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_PER_STORY,
    });

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("returns success when no passed stories exist (partial completion)", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "pending" },
        { id: "US-002", status: "failed" },
      ]),
      workdir: WORKDIR_NO_PASSED,
    });

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(0);
    expect(result.failedTests).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("result shape has all required fields", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([]),
      workdir: WORKDIR_SHAPE,
    });

    expect(typeof result.success).toBe("boolean");
    expect(typeof result.failedTests).toBe("number");
    expect(typeof result.passedTests).toBe("number");
    expect(typeof result.rectificationAttempts).toBe("number");
    expect(Array.isArray(result.affectedStories)).toBe(true);
  });

  test("affectedStories contains only string values", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_STORY_IDS,
    });

    for (const storyId of result.affectedStories) {
      expect(typeof storyId).toBe("string");
    }
  });

  test("passedTests is non-negative integer", async () => {
    const { runDeferredRegression } = await import(
      "../../../src/execution/lifecycle/run-regression"
    );

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_COUNTS,
    });

    expect(result.passedTests).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.passedTests)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runDeferredRegression - behavioral tests
// ---------------------------------------------------------------------------

const origRegressionDeps = {
  runVerification: _regressionDeps.runVerification,
  runRectificationLoop: _regressionDeps.runRectificationLoop,
  parseTestOutput: _regressionDeps.parseTestOutput,
};

describe.skip("runDeferredRegression - behavioral tests (with mocked deps)", () => {
  beforeEach(() => {
    _regressionDeps.runRectificationLoop = mock(async () => false);
  });

  afterEach(() => {
    Object.assign(_regressionDeps, origRegressionDeps);
    mock.restore();
  });

  test("full suite passes → success with 0 rectification attempts", async () => {
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => ({
      status: "SUCCESS",
      success: true,
      countsTowardEscalation: true,
      passCount: 42,
    }));

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_BEHAVIORAL,
    });

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(42);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("TIMEOUT + acceptOnTimeout=true → success", async () => {
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => ({
      status: "TIMEOUT",
      success: false,
      countsTowardEscalation: false,
    }));

    const config = makeConfig("deferred", "bun test");
    const result = await runDeferredRegression({
      config,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_TIMEOUT_ACCEPT,
    });

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(0);
  });

  test("TIMEOUT + acceptOnTimeout=false → failure", async () => {
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => ({
      status: "TIMEOUT",
      success: false,
      countsTowardEscalation: false,
    }));

    const config: NaxConfig = {
      ...makeConfig("deferred", "bun test"),
      execution: {
        ...makeConfig("deferred", "bun test").execution,
        regressionGate: {
          enabled: true,
          timeoutSeconds: 30,
          acceptOnTimeout: false,
          mode: "deferred",
          maxRectificationAttempts: 2,
        },
      },
    };

    const result = await runDeferredRegression({
      config,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_TIMEOUT_REJECT,
    });

    expect(result.success).toBe(false);
  });

  test("full suite fails with no output → failure immediately (no rectification)", async () => {
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => ({
      status: "TEST_FAILURE",
      success: false,
      countsTowardEscalation: true,
      failCount: 3,
    }));

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_NO_OUTPUT,
    });

    expect(result.success).toBe(false);
    expect(result.rectificationAttempts).toBe(0);
  });

  test("unmapped failures (no file field) → all passed stories in affectedStories", async () => {
    let verCallCount = 0;
    _regressionDeps.runVerification = mock(async (): Promise<VerificationResult> => {
      verCallCount++;
      if (verCallCount === 1) {
        return {
          status: "TEST_FAILURE",
          success: false,
          countsTowardEscalation: true,
          output: "FAIL: some test\nerror: boom",
          failCount: 1,
        };
      }
      return {
        status: "TEST_FAILURE",
        success: false,
        countsTowardEscalation: true,
        failCount: 1,
      };
    });

    _regressionDeps.parseTestOutput = mock(() => ({
      failed: 1,
      passed: 5,
      failures: [{ testName: "some test", error: "boom" }],
    })) as unknown as typeof _regressionDeps.parseTestOutput;

    _regressionDeps.runRectificationLoop = mock(async () => false);

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "passed" },
        { id: "US-002", status: "passed" },
      ]),
      workdir: WORKDIR_UNMAPPED,
    });

    expect(result.affectedStories).toContain("US-001");
    expect(result.affectedStories).toContain("US-002");
  });
});
