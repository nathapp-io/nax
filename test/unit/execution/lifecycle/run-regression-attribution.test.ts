/**
 * Unit tests for deferred-regression blame attribution.
 *
 * Covers the transition-based attribution that replaces the git-recency
 * heuristic: a failing test is attributed to the EARLIEST story whose
 * per-story full-suite-gate snapshot shows it failing (i.e. the story where
 * the test transitioned pass -> fail). Falls back to the git heuristic when no
 * snapshot data is available (e.g. single-session + deferred, which has no
 * per-story gate).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _regressionDeps, findResponsibleStoryByTransition, runDeferredRegression } from "@/execution";
import type { DeferredRegressionOptions, StorySnapshot } from "@/execution";
import type { PRD } from "@/prd";
import { _gitDeps } from "@/utils/git";
import { makeMockRuntime, makeNaxConfig } from "@test/helpers";

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

function makePrd(storyIds: string[]): PRD {
  return {
    userStories: storyIds.map((id) => ({ id, status: "passed", title: id })),
  } as unknown as PRD;
}

describe("runDeferredRegression — transition attribution", () => {
  let savedDeps: typeof _regressionDeps;
  beforeEach(() => {
    savedDeps = { ..._regressionDeps };
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

  test("falls back to the git heuristic when no snapshot maps the failing test", async () => {
    // No snapshot contains foo.test.ts → transition returns undefined → git
    // fallback maps the test to the most-recently-committed passed story.
    _regressionDeps.runVerification = mock(async () =>
      _regressionDeps.runVerification.mock.calls.length === 1
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
          },
    );
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
    // Make every git query report "has commits" so the heuristic returns the
    // most-recent passed story (US-002).
    const origSpawn = _gitDeps.spawn;
    _gitDeps.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: "abc1234 commit",
      stderr: "",
      kill: () => {},
    })) as unknown as typeof _gitDeps.spawn;

    try {
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

      expect(result.affectedStories).toEqual(["US-002"]);
      expect(rectified).toEqual(["US-002"]);
    } finally {
      _gitDeps.spawn = origSpawn;
    }
  });

  test("does not blame a transition hit that is not a passed story (guard)", async () => {
    // Snapshot points at US-099, which is not among the passed stories. The
    // guard must reject it and fall back to git (which maps nothing in /tmp),
    // so US-099 is never added to affected stories.
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

    const result = await runDeferredRegression({
      config: deferredConfig,
      prd: makePrd(["US-001", "US-002"]),
      workdir: "/tmp/test-workdir",
      runtime: makeMockRuntime(),
      storyMetrics: [snap("US-099", "2026-01-01T00:01:00.000Z", ["foo.test.ts"])],
    } as unknown as DeferredRegressionOptions);

    expect(result.affectedStories).not.toContain("US-099");
    expect(result.affectedStories).toEqual([]);
  });
});
