/**
 * reconstructTimeline — Pure timeline reconstruction (US-002)
 *
 * AC-6:  @/replay exposes `reconstructTimeline`.
 * AC-7:  RunTimeline.runId / .feature / .stories.length match metrics when matched.
 * AC-8:  StoryTimeline.status / .finalTier / .cost / .attempts come from StoryMetrics.
 * AC-9:  status="crashed" + story.cost===undefined when status.json carries a crash
 *        signal but no matching RunMetrics entry exists.
 * AC-10: StoryTimeline.rootCausePhaseIndex points at the inferred failed phase.
 * AC-11: RunTimeline.inferred === true.
 * AC-12: RunTimeline.naxVersion pulled from a `run.start` entry's data.
 */

import { describe, expect, test } from "bun:test";
import { reconstructTimeline, type RunTimeline, type StoryTimeline } from "@/replay";
import type { LogEntry } from "@/logger/types";
import type { RunMetrics, StoryMetrics } from "@/metrics/types";
import type { NaxStatusFile } from "@/execution/status-file";

function entry(partial: Partial<LogEntry>): LogEntry {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "info",
    stage: partial.stage ?? "story-orchestrator",
    message: partial.message ?? "",
    ...(partial.storyId !== undefined ? { storyId: partial.storyId } : {}),
    ...(partial.sessionRole !== undefined ? { sessionRole: partial.sessionRole } : {}),
    ...(partial.data !== undefined ? { data: partial.data } : {}),
  };
}

function phaseEntry(storyId: string, result: "pass" | "fail", opName: string): LogEntry {
  return entry({
    stage: "story-orchestrator",
    message: `Phase ${result === "pass" ? "passed" : "failed"}: ${opName}`,
    storyId,
    data: { storyId, phase: opName },
  });
}

function buildStoryMetrics(overrides: Partial<StoryMetrics> & { storyId: string }): StoryMetrics {
  const { storyId, ...rest } = overrides;
  return {
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-test",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0.01,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...rest,
    storyId,
  };
}

function buildRunMetrics(overrides: Partial<RunMetrics> & { runId: string; feature: string; stories: StoryMetrics[] }): RunMetrics {
  const { stories, ...rest } = overrides;
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:10.000Z",
    totalCost: stories.reduce((acc, s) => acc + s.cost, 0),
    totalStories: stories.length,
    storiesCompleted: stories.filter((s) => s.success).length,
    storiesFailed: stories.filter((s) => !s.success).length,
    totalDurationMs: 10000,
    ...rest,
    stories,
  };
}

function crashedStatus(overrides: Partial<NaxStatusFile["run"]> = {}): NaxStatusFile {
  return {
    version: 1,
    run: {
      id: "run-crash",
      feature: "feat-x",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "crashed",
      dryRun: false,
      pid: 1234,
      crashedAt: "2026-01-01T00:00:05.000Z",
      crashSignal: "SIGKILL",
      ...overrides,
    },
    progress: { total: 2, passed: 0, failed: 0, paused: 0, blocked: 0, pending: 2 },
    cost: { spent: 0, limit: null },
    current: null,
    iterations: 0,
    updatedAt: "2026-01-01T00:00:05.000Z",
    durationMs: 5000,
  };
}

// ---------------------------------------------------------------------------
// AC-6: barrel export
// ---------------------------------------------------------------------------

describe("reconstructTimeline — barrel export", () => {
  test("AC6: is exported from @/replay as a callable function", () => {
    expect(typeof reconstructTimeline).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-7: runId / feature / stories.length match metrics
// ---------------------------------------------------------------------------

describe("reconstructTimeline — AC7: runId, feature, stories match metrics", () => {
  test("AC7: RunTimeline.runId equals metrics.runId", () => {
    const metrics = buildRunMetrics({
      runId: "run-001",
      feature: "feat-auth",
      stories: [buildStoryMetrics({ storyId: "US-001" })],
    });
    const meta = { runId: "run-001", feature: "feat-auth" };

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta });

    expect(tl.runId).toBe("run-001");
  });

  test("AC7: RunTimeline.feature equals metrics.feature", () => {
    const metrics = buildRunMetrics({
      runId: "run-001",
      feature: "feat-auth",
      stories: [buildStoryMetrics({ storyId: "US-001" })],
    });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-auth" } });

    expect(tl.feature).toBe("feat-auth");
  });

  test("AC7: RunTimeline.stories length equals number of stories in RunMetrics", () => {
    const metrics = buildRunMetrics({
      runId: "run-001",
      feature: "feat-auth",
      stories: [
        buildStoryMetrics({ storyId: "US-001" }),
        buildStoryMetrics({ storyId: "US-002", success: false, cost: 0.02 }),
        buildStoryMetrics({ storyId: "US-003" }),
      ],
    });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-auth" } });

    expect(tl.stories.length).toBe(3);
  });

  test("AC7 boundary: feature comes from meta.feature when metrics.feature disagrees", () => {
    const metrics = buildRunMetrics({
      runId: "run-001",
      feature: "feat-auth",
      stories: [buildStoryMetrics({ storyId: "US-001" })],
    });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-auth" } });

    expect(tl.feature).toBe("feat-auth");
  });
});

// ---------------------------------------------------------------------------
// AC-8: StoryTimeline fields derived from StoryMetrics
// ---------------------------------------------------------------------------

describe("reconstructTimeline — AC8: StoryTimeline fields from StoryMetrics", () => {
  test("AC8: status='passed' when StoryMetrics.success is true", () => {
    const sm = buildStoryMetrics({ storyId: "US-001", success: true, finalTier: "balanced", cost: 0.42, attempts: 2 });
    const metrics = buildRunMetrics({ runId: "run-001", feature: "feat-x", stories: [sm] });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-x" } });
    const story: StoryTimeline = tl.stories[0]!;

    expect(story.status).toBe("passed");
  });

  test("AC8: finalTier matches StoryMetrics.finalTier", () => {
    const sm = buildStoryMetrics({ storyId: "US-001", success: true, finalTier: "balanced", cost: 0.42, attempts: 2 });
    const metrics = buildRunMetrics({ runId: "run-001", feature: "feat-x", stories: [sm] });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-x" } });
    const story = tl.stories[0]!;

    expect(story.finalTier).toBe("balanced");
  });

  test("AC8: cost matches StoryMetrics.cost", () => {
    const sm = buildStoryMetrics({ storyId: "US-001", success: true, finalTier: "balanced", cost: 0.42, attempts: 2 });
    const metrics = buildRunMetrics({ runId: "run-001", feature: "feat-x", stories: [sm] });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-x" } });
    const story = tl.stories[0]!;

    expect(story.cost).toBe(0.42);
  });

  test("AC8: attempts matches StoryMetrics.attempts", () => {
    const sm = buildStoryMetrics({ storyId: "US-001", success: true, finalTier: "balanced", cost: 0.42, attempts: 2 });
    const metrics = buildRunMetrics({ runId: "run-001", feature: "feat-x", stories: [sm] });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-x" } });
    const story = tl.stories[0]!;

    expect(story.attempts).toBe(2);
  });

  test("AC8 combined: status, finalTier, cost, attempts all derived together", () => {
    const sm = buildStoryMetrics({ storyId: "US-001", success: true, finalTier: "balanced", cost: 0.42, attempts: 2 });
    const metrics = buildRunMetrics({ runId: "run-001", feature: "feat-x", stories: [sm] });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-x" } });
    const story = tl.stories[0]!;

    expect({
      status: story.status,
      finalTier: story.finalTier,
      cost: story.cost,
      attempts: story.attempts,
    }).toEqual({ status: "passed", finalTier: "balanced", cost: 0.42, attempts: 2 });
  });
});

// ---------------------------------------------------------------------------
// AC-9: status='crashed' + StoryTimeline.cost===undefined when status.json carries crash
//       signal but no matching RunMetrics entry
// ---------------------------------------------------------------------------

describe("reconstructTimeline — AC9: crashed-run degradation", () => {
  test("AC9: RunTimeline.status is 'crashed' when status.json is crashed and no metrics exist", () => {
    const status = crashedStatus();
    const tl = reconstructTimeline({ entries: [], status, meta: { runId: "run-crash", feature: "feat-x" } });

    expect(tl.status).toBe("crashed");
  });

  test("AC9: StoryTimeline.cost is undefined for each story when no metrics are present", () => {
    const status = crashedStatus();
    const entries: LogEntry[] = [
      phaseEntry("US-001", "pass", "test-writer"),
      phaseEntry("US-002", "pass", "implementer"),
    ];

    const tl = reconstructTimeline({ entries, status, meta: { runId: "run-crash", feature: "feat-x" } });

    expect(tl.stories.length).toBeGreaterThan(0);
    for (const story of tl.stories) {
      expect(story.cost).toBeUndefined();
    }
  });

  test("AC9 boundary: without a status.json carrying crash signal + without metrics, run is not 'crashed'", () => {
    const tl = reconstructTimeline({ entries: [], meta: { runId: "run-x", feature: "feat-x" } });

    expect(tl.status).not.toBe("crashed");
  });

  test.each(["failed", "stalled", "precheck-failed"] as const)(
    "AC9 degrade: status.json status '%s' with no metrics degrades to 'failed', not 'completed'",
    (status) => {
      const statusFile = crashedStatus({ status, crashedAt: undefined, crashSignal: undefined });
      const tl = reconstructTimeline({ entries: [], status: statusFile, meta: { runId: "run-x", feature: "feat-x" } });

      expect(tl.status).toBe("failed");
    },
  );

  test("AC9 boundary: status.json status 'running' with no metrics stays 'completed' (run still in progress)", () => {
    const statusFile = crashedStatus({ status: "running", crashedAt: undefined, crashSignal: undefined });
    const tl = reconstructTimeline({ entries: [], status: statusFile, meta: { runId: "run-x", feature: "feat-x" } });

    expect(tl.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// AC-10: rootCausePhaseIndex points at the inferred failed phase
// ---------------------------------------------------------------------------

describe("reconstructTimeline — AC10: rootCausePhaseIndex", () => {
  test("AC10: rootCausePhaseIndex equals the index of the inferred failed phase for a failed story", () => {
    const sm = buildStoryMetrics({ storyId: "US-002", success: false });
    const metrics = buildRunMetrics({ runId: "run-001", feature: "feat-x", stories: [sm] });
    const entries: LogEntry[] = [
      phaseEntry("US-002", "pass", "test-writer"),
      phaseEntry("US-002", "pass", "implementer"),
      phaseEntry("US-002", "fail", "full-suite-gate"),
    ];

    const tl = reconstructTimeline({ entries, runMetrics: metrics, meta: { runId: "run-001", feature: "feat-x" } });
    const story = tl.stories.find((s) => s.storyId === "US-002");

    expect(story).toBeDefined();
    const failedIndex = story!.phases.findIndex((p) => p.status === "fail");
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(story!.rootCausePhaseIndex).toBe(failedIndex);
  });

  test("AC10: failed story with full-suite-gate as the last inferred phase has rootCausePhaseIndex = last index", () => {
    const sm = buildStoryMetrics({ storyId: "US-002", success: false });
    const metrics = buildRunMetrics({ runId: "run-001", feature: "feat-x", stories: [sm] });
    const entries: LogEntry[] = [
      phaseEntry("US-002", "pass", "test-writer"),
      phaseEntry("US-002", "pass", "implementer"),
      phaseEntry("US-002", "fail", "full-suite-gate"),
    ];

    const tl = reconstructTimeline({ entries, runMetrics: metrics, meta: { runId: "run-001", feature: "feat-x" } });
    const story = tl.stories.find((s) => s.storyId === "US-002")!;

    expect(story.rootCausePhaseIndex).toBe(story.phases.length - 1);
    expect(story.phases[story.rootCausePhaseIndex!]!.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// AC-11: RunTimeline.inferred === true
// ---------------------------------------------------------------------------

describe("reconstructTimeline — AC11: inferred flag", () => {
  test("AC11: RunTimeline.inferred is true (phases are best-effort reconstruction)", () => {
    const metrics = buildRunMetrics({
      runId: "run-001",
      feature: "feat-x",
      stories: [buildStoryMetrics({ storyId: "US-001" })],
    });
    const tl: RunTimeline = reconstructTimeline({
      entries: [],
      runMetrics: metrics,
      meta: { runId: "run-001", feature: "feat-x" },
    });

    expect(tl.inferred).toBe(true);
  });

  test("AC11: inferred stays true even on crashed-run paths", () => {
    const status = crashedStatus();
    const tl = reconstructTimeline({ entries: [], status, meta: { runId: "run-crash", feature: "feat-x" } });

    expect(tl.inferred).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-12: naxVersion pulled from a run.start entry's data
// ---------------------------------------------------------------------------

describe("reconstructTimeline — AC12: naxVersion", () => {
  test("AC12: naxVersion equals '0.71.1' when log spine has a run.start entry with that version", () => {
    const entries: LogEntry[] = [
      entry({
        stage: "run.start",
        message: "Starting feature",
        data: { naxVersion: "0.71.1" },
      }),
    ];
    const metrics = buildRunMetrics({
      runId: "run-001",
      feature: "feat-x",
      stories: [buildStoryMetrics({ storyId: "US-001" })],
    });

    const tl = reconstructTimeline({
      entries,
      runMetrics: metrics,
      meta: { runId: "run-001", feature: "feat-x" },
    });

    expect(tl.naxVersion).toBe("0.71.1");
  });

  test("AC12 boundary: naxVersion is undefined when log spine has no run.start entry", () => {
    const metrics = buildRunMetrics({
      runId: "run-001",
      feature: "feat-x",
      stories: [buildStoryMetrics({ storyId: "US-001" })],
    });

    const tl = reconstructTimeline({ entries: [], runMetrics: metrics, meta: { runId: "run-001", feature: "feat-x" } });

    expect(tl.naxVersion).toBeUndefined();
  });
});
