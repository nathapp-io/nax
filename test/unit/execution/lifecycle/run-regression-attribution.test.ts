/**
 * Unit tests for deferred-regression blame attribution.
 *
 * Covers transition-based attribution: a failing test is attributed to the
 * EARLIEST story whose
 * per-story full-suite-gate snapshot shows it failing (i.e. the story where
 * the test transitioned pass -> fail). Failures without causal attribution are
 * left unresolved rather than assigned to an unrelated passed story.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _regressionDeps, findResponsibleStoryByTransition, runDeferredRegression } from "@/execution";
import type { DeferredRegressionOptions, StorySnapshot } from "@/execution";
import type { Finding } from "@/findings/types";
import type { PRD, UserStory } from "@/prd";
import { _gitDeps } from "@/utils/git";
import { makeMockRuntime, makeNaxConfig, makePRD } from "@test/helpers";

function snap(storyId: string, completedAt: string, failingTestFiles?: string[]): StorySnapshot {
  return { storyId, completedAt, failingTestFiles };
}

describe("findResponsibleStoryByTransition", () => {
  test("blames the earliest story whose snapshot shows the test failing", () => {
    const snapshots: StorySnapshot[] = [
      snap("US-001", "2026-01-01T00:00:00.000Z", []),
      snap("US-002", "2026-01-01T00:01:00.000Z", ["foo.test.ts"]),
      snap("US-003", "2026-01-01T00:02:00.000Z", ["foo.test.ts"]),
    ];
    expect(findResponsibleStoryByTransition("foo.test.ts", snapshots)).toBe("US-002");
  });

  test("returns undefined when no snapshot contains the failing test", () => {
    const snapshots: StorySnapshot[] = [
      snap("US-001", "2026-01-01T00:00:00.000Z", ["bar.test.ts"]),
      snap("US-002", "2026-01-01T00:01:00.000Z", []),
    ];
    expect(findResponsibleStoryByTransition("foo.test.ts", snapshots)).toBeUndefined();
  });

  test("returns undefined for empty snapshot list", () => {
    expect(findResponsibleStoryByTransition("foo.test.ts", [])).toBeUndefined();
  });

  test("orders by completedAt, not array order, when finding the first transition", () => {
    // Array is deliberately out of chronological order.
    const snapshots: StorySnapshot[] = [
      snap("US-003", "2026-01-01T00:02:00.000Z", ["foo.test.ts"]),
      snap("US-002", "2026-01-01T00:01:00.000Z", ["foo.test.ts"]),
      snap("US-001", "2026-01-01T00:00:00.000Z", []),
    ];
    expect(findResponsibleStoryByTransition("foo.test.ts", snapshots)).toBe("US-002");
  });

  test("ignores snapshots with undefined failingTestFiles", () => {
    const snapshots: StorySnapshot[] = [
      snap("US-001", "2026-01-01T00:00:00.000Z", undefined),
      snap("US-002", "2026-01-01T00:01:00.000Z", ["foo.test.ts"]),
    ];
    expect(findResponsibleStoryByTransition("foo.test.ts", snapshots)).toBe("US-002");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: transition attribution beats the git-recency heuristic
// ─────────────────────────────────────────────────────────────────────────────

const deferredConfig = makeNaxConfig({
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
    regressionGate: { mode: "deferred", timeoutSeconds: 60, acceptOnTimeout: true },
  },
});

function makePrd(storyIds: string[], failedStoryIds: ReadonlySet<string> = new Set()): PRD {
  return makePRD({
    userStories: storyIds.map((id) => ({
      id,
      status: failedStoryIds.has(id) ? "failed" : "passed",
      title: id,
    })) as unknown as UserStory[],
  });
}

describe("runDeferredRegression — transition attribution", () => {
  let savedDeps: typeof _regressionDeps;
  beforeEach(() => {
    savedDeps = { ..._regressionDeps };
    // Default triage stub — pass findings through unchanged, no quarantine.
    // These tests don't exercise triage behaviour; using a no-op stub isolates
    // them from the real triage implementation (which would otherwise invoke
    // a probe loop in the test environment).
    _regressionDeps.triageFlakyFindings = (async (input: {
      findings: Finding[];
    }) => ({
      findings: input.findings.map((f) => ({ ...f })),
      quarantineReport: { keys: [], reasons: [] },
    })) as typeof _regressionDeps.triageFlakyFindings;
  });
  afterEach(() => {
    Object.assign(_regressionDeps, savedDeps);
  });

  test("attributes a failing test to the story where it went pass -> fail, not the most recent", async () => {
    // foo.test.ts went red at US-002 (and stays red through US-003). The
    // git-recency heuristic would blame US-003 (most recent); transition blames US-002.
    _regressionDeps.runVerification = mock(async () => {
      // call 0: initial suite fails; subsequent mid-loop re-runs pass (early exit).
      return _regressionDeps.runVerification.mock.calls.length === 1
        ? {
            success: false,
            status: "TEST_FAILURE",
            countsTowardEscalation: true,
            output: "fail",
            passCount: 0,
            failCount: 1,
          }
        : {
            success: true,
            status: "SUCCESS",
            countsTowardEscalation: false,
            output: "pass",
            passCount: 10,
            failCount: 0,
          };
    });
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 1,
      failures: [{ file: "foo.test.ts", testName: "t", error: "boom", stackTrace: [] }],
    }));
    const rectified: string[] = [];
    _regressionDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      rectified.push(cycleCtx.storyId);
      return {
        iterations: [],
        finalFindings: [],
        exitReason: "resolved" as const,
        costUsd: 0.1,
      };
    });

    const options = {
      config: deferredConfig,
      prd: makePrd(["US-001", "US-002", "US-003"]),
      workdir: "/tmp/test-workdir",
      runtime: makeMockRuntime(),
      storyMetrics: [
        snap("US-001", "2026-01-01T00:00:00.000Z", []),
        snap("US-002", "2026-01-01T00:01:00.000Z", ["foo.test.ts"]),
        snap("US-003", "2026-01-01T00:02:00.000Z", ["foo.test.ts"]),
      ],
    } as unknown as DeferredRegressionOptions;

    const result = await runDeferredRegression(options);

    expect(result.affectedStories).toEqual(["US-002"]);
    expect(result.affectedStories).not.toContain("US-003");
    expect(rectified).toEqual(["US-002"]);
  });

  test("leaves a failing test unattributed when no snapshot maps it", async () => {
    _regressionDeps.runVerification = mock(async () => ({
      success: false,
      status: "TEST_FAILURE",
      countsTowardEscalation: true,
      output: "fail",
      passCount: 0,
      failCount: 1,
    }));
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 1,
      failures: [{ file: "foo.test.ts", testName: "t", error: "boom", stackTrace: [] }],
    }));
    const rectified: string[] = [];
    _regressionDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      rectified.push(cycleCtx.storyId);
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    });
    const result = await runDeferredRegression({
      config: deferredConfig,
      prd: makePrd(["US-001", "US-002"]),
      workdir: "/tmp/test-workdir",
      runtime: makeMockRuntime(),
      storyMetrics: [
        snap("US-001", "2026-01-01T00:00:00.000Z", []),
        snap("US-002", "2026-01-01T00:01:00.000Z", ["bar.test.ts"]),
      ],
    } as unknown as DeferredRegressionOptions);

    expect(result.success).toBe(false);
    expect(result.affectedStories).toEqual([]);
    expect(rectified).toEqual([]);
  });

  test("does not blame a passed story for a failed story's test", async () => {
    _regressionDeps.runVerification = mock(async () => ({
      success: false,
      status: "TEST_FAILURE",
      countsTowardEscalation: true,
      output: "fail",
      passCount: 0,
      failCount: 1,
    }));
    _regressionDeps.parseTestOutput = mock(() => ({
      passed: 0,
      failed: 1,
      failures: [{ file: "foo.test.ts", testName: "t", error: "boom", stackTrace: [] }],
    }));
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0,
    }));

    const originalSpawn = _gitDeps.spawn;
    _gitDeps.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: "abc1234 chore(US-004): unrelated passing story",
      stderr: "",
      kill: () => {},
    })) as unknown as typeof _gitDeps.spawn;

    try {
      const result = await runDeferredRegression({
        config: deferredConfig,
        prd: makePrd(["US-003", "US-004"], new Set(["US-003"])),
        workdir: "/tmp/test-workdir",
        runtime: makeMockRuntime(),
        storyMetrics: [snap("US-003", "2026-01-01T00:01:00.000Z", ["foo.test.ts"])],
      } as unknown as DeferredRegressionOptions);

      expect(result.success).toBe(false);
      expect(result.affectedStories).not.toContain("US-004");
      expect(result.affectedStories).toEqual([]);
      expect(_regressionDeps.runFixCycle).not.toHaveBeenCalled();
    } finally {
      _gitDeps.spawn = originalSpawn;
    }
  });
});
