/**
 * Execution Lifecycle Tests — runDeferredRegression
 *
 * Tests for deferred regression execution logic.
 * Extracted from lifecycle.test.ts for size management.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeMockRuntime, makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _regressionDeps, runDeferredRegression } from "@/execution/lifecycle/run-regression";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD, UserStory } from "@/prd";
import type { FlakeTriageInput, FlakeTriageResult, VerificationResult } from "@/verification";

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

function makeConfig(regressionMode?: "deferred" | "per-story" | "disabled", testCommand?: string): NaxConfig {
  return makeNaxConfig({
    execution: {
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        ...(regressionMode !== undefined ? { mode: regressionMode } : {}),
      },
    },
    quality: {
      commands: {
        ...(testCommand ? { test: testCommand } : {}),
      },
    },
  });
}

function makeRuntime() {
  return makeMockRuntime();
}

// ---------------------------------------------------------------------------
// runDeferredRegression tests
// ---------------------------------------------------------------------------

describe("runDeferredRegression", () => {
  test("returns success immediately when mode is 'disabled'", async () => {
    const { runDeferredRegression } = await import("@/execution/lifecycle/run-regression");

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_DISABLED,
      runtime: makeRuntime(),
    });

    expect(result.success).toBe(true);
    expect(result.failedTests).toBe(0);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("runs the deferred suite when mode is 'per-story' (superset of deferred)", async () => {
    const { runDeferredRegression } = await import("@/execution/lifecycle/run-regression");

    // per-story no longer short-circuits — it runs the full suite. Mock it so we
    // don't spawn a real `bun test` in a nonexistent temp dir.
    const saved = { ..._regressionDeps };
    _regressionDeps.runVerification = mock(async () => ({
      success: true,
      status: "SUCCESS" as const,
      countsTowardEscalation: false,
      output: "5 pass | 0 fail",
      passCount: 5,
      failCount: 0,
    }));
    try {
      const result = await runDeferredRegression({
        config: makeConfig("per-story", "bun test"),
        prd: makePRD([{ id: "US-001", status: "passed" }]),
        workdir: WORKDIR_PER_STORY,
        runtime: makeRuntime(),
      });

      expect(result.success).toBe(true);
      expect(result.rectificationAttempts).toBe(0);
      expect(result.affectedStories).toEqual([]);
      expect(_regressionDeps.runVerification).toHaveBeenCalled();
    } finally {
      Object.assign(_regressionDeps, saved);
    }
  });

  test("returns success when no passed stories exist (partial completion)", async () => {
    const { runDeferredRegression } = await import("@/execution/lifecycle/run-regression");

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "pending" },
        { id: "US-002", status: "failed" },
      ]),
      workdir: WORKDIR_NO_PASSED,
      runtime: makeRuntime(),
    });

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(0);
    expect(result.failedTests).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("result shape has all required fields", async () => {
    const { runDeferredRegression } = await import("@/execution/lifecycle/run-regression");

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([]),
      workdir: WORKDIR_SHAPE,
      runtime: makeRuntime(),
    });

    expect(typeof result.success).toBe("boolean");
    expect(typeof result.failedTests).toBe("number");
    expect(typeof result.passedTests).toBe("number");
    expect(typeof result.rectificationAttempts).toBe("number");
    expect(Array.isArray(result.affectedStories)).toBe(true);
  });

  test("affectedStories contains only string values", async () => {
    const { runDeferredRegression } = await import("@/execution/lifecycle/run-regression");

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_STORY_IDS,
      runtime: makeRuntime(),
    });

    for (const storyId of result.affectedStories) {
      expect(typeof storyId).toBe("string");
    }
  });

  test("passedTests is non-negative integer", async () => {
    const { runDeferredRegression } = await import("@/execution/lifecycle/run-regression");

    const result = await runDeferredRegression({
      config: makeConfig("disabled", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_COUNTS,
      runtime: makeRuntime(),
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
  runFixCycle: _regressionDeps.runFixCycle,
  parseTestOutput: _regressionDeps.parseTestOutput,
};

describe("runDeferredRegression - behavioral tests (with mocked deps)", () => {
  beforeEach(() => {
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "max-attempts-total" as const,
      costUsd: 0,
    }));
  });

  afterEach(() => {
    Object.assign(_regressionDeps, origRegressionDeps);
    mock.restore();
  });

  test("full suite passes → success with 0 rectification attempts", async () => {
    _regressionDeps.runVerification = mock(
      async (): Promise<VerificationResult> => ({
        status: "SUCCESS",
        success: true,
        countsTowardEscalation: true,
        passCount: 42,
      }),
    );

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_BEHAVIORAL,
      runtime: makeRuntime(),
    });

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(42);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
  });

  test("TIMEOUT + acceptOnTimeout=true → success", async () => {
    _regressionDeps.runVerification = mock(
      async (): Promise<VerificationResult> => ({
        status: "TIMEOUT",
        success: false,
        countsTowardEscalation: false,
      }),
    );

    const config = makeConfig("deferred", "bun test");
    const result = await runDeferredRegression({
      config,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_TIMEOUT_ACCEPT,
      runtime: makeRuntime(),
    });

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(0);
  });

  test("TIMEOUT + acceptOnTimeout=false → failure", async () => {
    _regressionDeps.runVerification = mock(
      async (): Promise<VerificationResult> => ({
        status: "TIMEOUT",
        success: false,
        countsTowardEscalation: false,
      }),
    );

    const config: NaxConfig = {
      ...makeConfig("deferred", "bun test"),
      execution: {
        ...makeConfig("deferred", "bun test").execution,
        regressionGate: {
          enabled: true,
          timeoutSeconds: 30,
          acceptOnTimeout: false,
          mode: "deferred",
        },
      },
    };

    const result = await runDeferredRegression({
      config,
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_TIMEOUT_REJECT,
      runtime: makeRuntime(),
    });

    expect(result.success).toBe(false);
  });

  test("full suite fails with no output → failure immediately (no rectification)", async () => {
    _regressionDeps.runVerification = mock(
      async (): Promise<VerificationResult> => ({
        status: "TEST_FAILURE",
        success: false,
        countsTowardEscalation: true,
        failCount: 3,
      }),
    );

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_NO_OUTPUT,
      runtime: makeRuntime(),
    });

    expect(result.success).toBe(false);
    expect(result.rectificationAttempts).toBe(0);
  });

  test("unmapped failures (no file field) do not blame passed stories", async () => {
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
      failures: [{ file: "test/some.test.ts", testName: "some test", error: "boom", stackTrace: [] }],
    }));

    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "max-attempts-total" as const,
      costUsd: 0,
    }));

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "passed" },
        { id: "US-002", status: "passed" },
      ]),
      workdir: WORKDIR_UNMAPPED,
      runtime: makeRuntime(),
    });

    expect(result.success).toBe(false);
    expect(result.affectedStories).toEqual([]);
    expect(_regressionDeps.runFixCycle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Characterisation tests (B4 complexity drain) — branches the other suites
// leave unpinned. Written against the unrefactored runDeferredRegression; the
// refactor must keep every assertion in this block green unchanged.
// ---------------------------------------------------------------------------

describe("runDeferredRegression — unpinned gate and loop arms (B4 characterisation)", () => {
  let savedDeps: typeof _regressionDeps;
  beforeEach(() => {
    savedDeps = { ..._regressionDeps };
    // Pass-through triage stub — isolates these tests from the real triage
    // implementation, same pattern as run-regression.test.ts.
    _regressionDeps.triageFlakyFindings = async (input: FlakeTriageInput): Promise<FlakeTriageResult> => ({
      findings: input.findings.map((f) => ({ ...f })),
      quarantineReport: { keys: [], reasons: [] },
    });
  });
  afterEach(() => {
    Object.assign(_regressionDeps, savedDeps);
  });

  function failingWithOutput(output: string, passCount = 0): VerificationResult {
    return {
      status: "TEST_FAILURE",
      success: false,
      countsTowardEscalation: true,
      output,
      passCount,
      failCount: 2,
    };
  }

  test("BUG-REG-001: a crashed runner (zero parsed results) is accepted as a pass, not a regression", async () => {
    const verifyCalls: string[] = [];
    _regressionDeps.runVerification = mock(async () => {
      verifyCalls.push(`call-${verifyCalls.length}`);
      return failingWithOutput("error TS2304: Cannot find name 'missingSymbol'");
    });
    _regressionDeps.parseTestOutput = mock(() => ({ passed: 0, failed: 0, failures: [] }));
    _regressionDeps.runFixCycle = mock(async () => {
      throw new Error("no rectification may run for a crashed runner");
    });

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_COUNTS,
      runtime: makeRuntime(),
    });

    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(0);
    expect(result.rectificationAttempts).toBe(0);
    expect(result.affectedStories).toEqual([]);
    expect(verifyCalls).toHaveLength(1);
    expect(_regressionDeps.runFixCycle).not.toHaveBeenCalled();
  });

  test("emits one regression:detected event per affected story with the parsed failure count", async () => {
    _regressionDeps.runVerification = mock(async () => failingWithOutput("FAIL OUTPUT"));
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 92,
      failures: [
        { file: "foo.test.ts", testName: "f", error: "boom", stackTrace: [] },
        { file: "bar.test.ts", testName: "b", error: "boom", stackTrace: [] },
      ],
    }));
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "max-attempts-total" as const,
      costUsd: 0,
    }));

    const events: Array<{ storyId: string; failedTests: number }> = [];
    const off = pipelineEventBus.on("regression:detected", (event) => {
      events.push({ storyId: event.storyId, failedTests: event.failedTests });
    });

    try {
      await runDeferredRegression({
        config: makeConfig("deferred", "bun test"),
        prd: makePRD([
          { id: "US-001", status: "passed" },
          { id: "US-002", status: "passed" },
        ]),
        workdir: WORKDIR_STORY_IDS,
        runtime: makeRuntime(),
        storyMetrics: [
          { storyId: "US-001", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["foo.test.ts"] },
          { storyId: "US-002", completedAt: "2026-01-01T00:01:00.000Z", failingTestFiles: ["bar.test.ts"] },
        ],
      });
    } finally {
      off();
    }

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.storyId).sort((a, b) => a.localeCompare(b))).toEqual(["US-001", "US-002"]);
    for (const event of events) {
      expect(event.failedTests).toBe(92);
    }
  });

  test("a zero-iteration cycle still counts one rectification attempt", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return failingWithOutput("FAIL OUTPUT");
      return {
        status: "SUCCESS" as const,
        success: true,
        countsTowardEscalation: false,
        output: "5 pass | 0 fail",
        passCount: 5,
        failCount: 0,
      };
    });
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 2,
      failures: [{ file: "foo.test.ts", testName: "f", error: "boom", stackTrace: [] }],
    }));
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0.2,
    }));

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_SHAPE,
      runtime: makeRuntime(),
      storyMetrics: [{ storyId: "US-001", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["foo.test.ts"] }],
    });

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(1);
    expect(result.storyCosts?.["US-001"]).toBeCloseTo(0.2);
  });

  test("a mid-loop re-run that times out is accepted and the run exits early", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return failingWithOutput("FAIL OUTPUT");
      return { status: "TIMEOUT" as const, success: false, countsTowardEscalation: false };
    });
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 2,
      failures: [{ file: "foo.test.ts", testName: "f", error: "boom", stackTrace: [] }],
    }));
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [
        {
          iterationNum: 1,
          findingsBefore: [],
          fixesApplied: [],
          findingsAfter: [],
          outcome: "resolved" as const,
          startedAt: "",
          finishedAt: "",
        },
      ],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0.1,
    }));

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "passed" },
        { id: "US-002", status: "passed" },
      ]),
      workdir: WORKDIR_TIMEOUT_ACCEPT,
      runtime: makeRuntime(),
      storyMetrics: [{ storyId: "US-001", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["foo.test.ts"] }],
    });

    // Early exit with the accepted timeout: success, no passCount available.
    expect(result.success).toBe(true);
    expect(result.passedTests).toBe(0);
    expect(result.rectificationAttempts).toBe(1);
    expect(verifyCallIndex).toBe(2);
  });

  test("when a mid-loop re-run fails without output, the next story still sees the previous output", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return failingWithOutput("INITIAL_FAIL_OUTPUT");
      if (i === 1) return { status: "TEST_FAILURE" as const, success: false, countsTowardEscalation: true };
      return {
        status: "SUCCESS" as const,
        success: true,
        countsTowardEscalation: false,
        output: "5 pass | 0 fail",
        passCount: 5,
        failCount: 0,
      };
    });
    const capturedParseArgs: string[] = [];
    _regressionDeps.parseTestOutput = (output: string) => {
      capturedParseArgs.push(output);
      return {
        passed: 0,
        failed: 2,
        failures: [
          { file: "foo.test.ts", testName: "f", error: "boom", stackTrace: [] },
          { file: "bar.test.ts", testName: "b", error: "boom", stackTrace: [] },
        ],
      };
    };
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0,
    }));

    await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([
        { id: "US-001", status: "passed" },
        { id: "US-002", status: "passed" },
      ]),
      workdir: WORKDIR_BEHAVIORAL,
      runtime: makeRuntime(),
      storyMetrics: [
        { storyId: "US-001", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["foo.test.ts"] },
        { storyId: "US-002", completedAt: "2026-01-01T00:01:00.000Z", failingTestFiles: ["bar.test.ts"] },
      ],
    });

    // capturedParseArgs[0] = initial summary; [1] = US-001 findings; [2] = US-002 findings.
    // The output-less mid re-run must NOT clear the forwarded context.
    expect(capturedParseArgs[1]).toBe("INITIAL_FAIL_OUTPUT");
    expect(capturedParseArgs[2]).toBe("INITIAL_FAIL_OUTPUT");
  });

  test("the final re-run timing out is accepted as success after rectification", async () => {
    let verifyCallIndex = 0;
    _regressionDeps.runVerification = mock(async () => {
      const i = verifyCallIndex++;
      if (i === 0) return failingWithOutput("FAIL OUTPUT");
      if (i === 1) return failingWithOutput("STILL_FAIL_OUTPUT"); // mid after US-001: no early exit
      return { status: "TIMEOUT" as const, success: false, countsTowardEscalation: false };
    });
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 2,
      failures: [{ file: "foo.test.ts", testName: "f", error: "boom", stackTrace: [] }],
    }));
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0.3,
    }));

    const result = await runDeferredRegression({
      config: makeConfig("deferred", "bun test"),
      prd: makePRD([{ id: "US-001", status: "passed" }]),
      workdir: WORKDIR_TIMEOUT_REJECT,
      runtime: makeRuntime(),
      storyMetrics: [{ storyId: "US-001", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["foo.test.ts"] }],
    });

    expect(result.success).toBe(true);
    expect(result.rectificationAttempts).toBe(1);
    expect(result.storyCosts?.["US-001"]).toBeCloseTo(0.3);
    expect(verifyCallIndex).toBe(3);
  });

  test("attribution logs name the mapped story, and unresolved transitions warn per arm", async () => {
    _regressionDeps.runVerification = mock(async () => failingWithOutput("FAIL OUTPUT"));
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 3,
      failures: [
        { file: "foo.test.ts", testName: "f", error: "boom", stackTrace: [] },
        { file: "bar.test.ts", testName: "b", error: "boom", stackTrace: [] },
        { file: "baz.test.ts", testName: "z", error: "boom", stackTrace: [] },
      ],
    }));
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "max-attempts-total" as const,
      costUsd: 0,
    }));

    // Another test file in the same process may have left a logger behind.
    resetLogger();
    initLogger({ level: "silent" });
    const logCalls: LogEntry[] = [];
    const removeSink = addSink((entry) => logCalls.push(entry));
    try {
      // US-002 is FAILED: foo.test.ts transitions there but cannot be blamed on
      // it (warn carries transitionStoryId). bar.test.ts maps to passed US-003.
      // baz.test.ts has no transition at all (warn carries no transitionStoryId).
      await runDeferredRegression({
        config: makeConfig("deferred", "bun test"),
        prd: makePRD([
          { id: "US-001", status: "passed" },
          { id: "US-002", status: "failed" },
          { id: "US-003", status: "passed" },
        ]),
        workdir: WORKDIR_UNMAPPED,
        runtime: makeRuntime(),
        storyMetrics: [
          { storyId: "US-002", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["foo.test.ts"] },
          { storyId: "US-003", completedAt: "2026-01-01T00:01:00.000Z", failingTestFiles: ["bar.test.ts"] },
        ],
      });
    } finally {
      removeSink();
      resetLogger();
    }

    const mapped = logCalls.find((l) => l.message === "Mapped test to story via gate transition");
    expect(mapped?.stage).toBe("regression");
    expect(mapped?.data).toMatchObject({ storyId: "US-003", testFile: "bar.test.ts" });

    const unresolved = logCalls.filter((l) => l.message === "Could not safely map test file to a passed story");
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]?.data).toMatchObject({ testFile: "foo.test.ts", transitionStoryId: "US-002" });
    expect(unresolved[1]?.data).toMatchObject({ testFile: "baz.test.ts" });
    expect(unresolved[1]?.data?.transitionStoryId).toBeUndefined();
  });
});
