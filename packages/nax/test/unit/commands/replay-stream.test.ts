/**
 * runReplay — streamed ingestion and per-story indexing (US-006)
 *
 * AC-1: filtered and unfiltered report content stays equivalent to the existing
 *       reconstruction for interleaved run-level and multi-story events,
 *       including phase order and missing-log handling.
 * AC-2: with 10,000 input records, going from 1 to 100 stories does not
 *       multiply record inspections — one pass, including `--story`.
 * AC-7: a log path that is a symlink or nonregular file is reported instead of
 *       being streamed into a report.
 *
 * These cases wire the real ingestion, reconstruction and rendering through
 * `_replayCmdDeps`-shaped deps; only discovery, metrics and status are stubbed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _replayCmdDeps, type ReplayCommandDeps, type ReplayCommandOptions, runReplay } from "@/commands";
import type { NaxStatusFile } from "@/execution/status-file";
import type { LogEntry } from "@/logger/types";
import type { RunMetrics, StoryMetrics } from "@/metrics";
import type { ReplayEventIndex, RunTimeline } from "@/replay";
import { readReplayEvents, reconstructTimeline, renderReport, toReplayJson } from "@/replay";

const TS = "2026-01-01T00:00:00.000Z";
const RECORD_COUNT = 10_000;
const BIG_STORY_COUNT = 100;

function rec(partial: Partial<LogEntry> & { message: string }): LogEntry {
  return { timestamp: TS, level: "info", stage: partial.stage ?? "story-orchestrator", ...partial };
}

function phase(storyId: string, result: "pass" | "fail", name: string): LogEntry {
  return rec({
    stage: "story-orchestrator",
    message: `Phase ${result === "pass" ? "passed" : "failed"}: ${name}`,
    storyId,
    data: { storyId, phase: name },
  });
}

/** A phase record whose nested `data.storyId` names a different story. */
function nestedPhase(topId: string, result: "pass" | "fail", name: string, nestedId: string): LogEntry {
  return rec({
    stage: "story-orchestrator",
    message: `Phase ${result === "pass" ? "passed" : "failed"}: ${name}`,
    storyId: topId,
    data: { storyId: nestedId, phase: name },
  });
}

function storyMetrics(storyId: string, success: boolean): StoryMetrics {
  return {
    storyId,
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-test",
    attempts: 1,
    finalTier: "balanced",
    success,
    cost: success ? 0.01 : 0.02,
    durationMs: 1000,
    firstPassSuccess: success,
    startedAt: TS,
    completedAt: TS,
  };
}

function runMetrics(stories: StoryMetrics[]): RunMetrics {
  return {
    runId: "run-1",
    feature: "feat-1",
    startedAt: TS,
    completedAt: TS,
    totalCost: stories.reduce((acc, s) => acc + s.cost, 0),
    totalStories: stories.length,
    storiesCompleted: stories.filter((s) => s.success).length,
    storiesFailed: stories.filter((s) => !s.success).length,
    totalDurationMs: 1000,
    stories,
  };
}

function writeLog(dir: string, name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function toLines(entries: LogEntry[]): string[] {
  return entries.map((e) => JSON.stringify(e));
}

/** Independent, non-streaming JSONL parser — the reference side of AC-1's comparison. */
function parseJsonlFile(path: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // reference parser skips malformed records, as replay always has
    }
  }
  return entries;
}

interface StreamRun {
  exit: number;
  stdout: string;
  stderr: string;
  index: ReplayEventIndex | undefined;
  timeline: RunTimeline | undefined;
}

/**
 * Drive `runReplay` with the real ingestion, reconstruction, rendering and
 * serialization; only discovery/metrics/status are stubbed.
 */
async function runStreamed(
  jsonlPath: string | null,
  metrics: RunMetrics | undefined,
  options: ReplayCommandOptions = {},
  status?: NaxStatusFile,
): Promise<StreamRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captured: { index?: ReplayEventIndex; timeline?: RunTimeline } = {};
  const deps: ReplayCommandDeps = {
    discoverRun: mock(async () => ({
      meta: {
        runId: "run-1",
        project: "demo",
        feature: "feat-1",
        workdir: "/tmp",
        statusPath: "/tmp/missing-status.json",
        eventsDir: "/tmp/events",
        registeredAt: TS,
      },
      jsonlPath,
    })),
    readEvents: async (path: string) => {
      captured.index = await readReplayEvents(path);
      return captured.index;
    },
    readMetrics: mock(async () => metrics),
    readStatus: mock(async () => status),
    reconstructTimeline: (inputs) => {
      captured.timeline = reconstructTimeline(inputs);
      return captured.timeline;
    },
    renderReport,
    toReplayJson,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };

  const exit = await runReplay("run-1", options, deps);
  return { exit, stdout: stdout.join(""), stderr: stderr.join(""), index: captured.index, timeline: captured.timeline };
}

/** The record spine used by AC-1: run-level lines interleaved with three stories. */
function interleavedSpine(): LogEntry[] {
  return [
    rec({ stage: "run.start", message: "Starting run", data: { naxVersion: "0.94.2" } }),
    phase("US-001", "pass", "test-writer"),
    rec({ stage: "runner", message: "run-level progress line" }),
    nestedPhase("US-001", "pass", "implementer", "US-003"),
    phase("US-002", "pass", "test-writer"),
    rec({ stage: "agent-manager", message: "fail-stale: retry", storyId: "US-002", data: { storyId: "US-002" } }),
    phase("US-002", "fail", "implementer"),
    rec({ stage: "runner", message: "another run-level line" }),
    phase("US-002", "fail", "full-suite-gate"),
    rec({ stage: "findings.cycle", message: "cycle 1", storyId: "US-002", data: { storyId: "US-002" } }),
  ];
}

function interleavedMetrics(): RunMetrics {
  return runMetrics([storyMetrics("US-001", true), storyMetrics("US-002", false), storyMetrics("US-003", true)]);
}

function referenceReport(
  path: string,
  metrics: RunMetrics | undefined,
  options: { story?: string; all?: boolean } = {},
) {
  const timeline = reconstructTimeline({
    entries: parseJsonlFile(path),
    ...(metrics !== undefined ? { runMetrics: metrics } : {}),
    meta: { runId: "run-1", feature: "feat-1" },
  });
  return renderReport(timeline, options);
}

describe("runReplay — AC1: streamed report equals the existing reconstruction", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = makeTempDir("nax-replay-stream-run-");
    logPath = writeLog(dir, "run-1.jsonl", toLines(interleavedSpine()));
  });

  afterEach(() => cleanupTempDir(dir));

  test("AC1: unfiltered report is byte-identical to the entries-driven reconstruction", async () => {
    const run = await runStreamed(logPath, interleavedMetrics());

    expect(run.exit).toBe(0);
    expect(run.stdout).toBe(`${referenceReport(logPath, interleavedMetrics())}\n`);
  });

  test("AC1: --story filtered report is byte-identical to filtering the same reconstruction", async () => {
    const run = await runStreamed(logPath, interleavedMetrics(), { story: "US-002" });

    expect(run.stdout).toBe(`${referenceReport(logPath, interleavedMetrics(), { story: "US-002" })}\n`);
    expect(run.stdout).toContain("Stories: 1 (of 3)");
  });

  test("AC1: --all report is byte-identical too", async () => {
    const run = await runStreamed(logPath, interleavedMetrics(), { all: true });

    expect(run.stdout).toBe(`${referenceReport(logPath, interleavedMetrics(), { all: true })}\n`);
  });

  test("AC1: interleaved stories keep their own phase order and run-level context", async () => {
    const run = await runStreamed(logPath, interleavedMetrics());
    const timeline = run.timeline;

    expect(timeline?.naxVersion).toBe("0.94.2");
    expect(timeline?.status).toBe("failed");
    expect(
      timeline?.stories.map((s) => ({
        storyId: s.storyId,
        status: s.status,
        phases: s.phases,
        rootCause: s.rootCausePhaseIndex,
      })),
    ).toEqual([
      {
        storyId: "US-001",
        status: "passed",
        phases: [
          { name: "test-writer", status: "pass" },
          { name: "implementer", status: "pass" },
        ],
        rootCause: undefined,
      },
      {
        storyId: "US-002",
        status: "failed",
        phases: [
          { name: "test-writer", status: "pass" },
          { name: "implementer", status: "fail" },
          { name: "full-suite-gate", status: "fail" },
        ],
        rootCause: 1,
      },
      { storyId: "US-003", status: "passed", phases: [{ name: "implementer", status: "pass" }], rootCause: undefined },
    ]);
  });

  test("AC1: the degraded (crashed, no metrics) report still reconstructs discovered stories", async () => {
    const status: NaxStatusFile = {
      version: 1,
      run: {
        id: "run-1",
        feature: "feat-1",
        startedAt: TS,
        status: "crashed",
        dryRun: false,
        pid: 1234,
        crashedAt: TS,
        crashSignal: "SIGKILL",
      },
      progress: { total: 3, passed: 0, failed: 0, paused: 0, blocked: 0, pending: 3 },
      cost: { spent: 0, limit: null },
      current: null,
      iterations: 0,
      updatedAt: TS,
      durationMs: 1000,
    };

    const run = await runStreamed(logPath, undefined, {}, status);

    expect(run.exit).toBe(0);
    // Same discovery rules as the entries path: top-level IDs, in first-seen order.
    const reference = reconstructTimeline({
      entries: parseJsonlFile(logPath),
      status,
      meta: { runId: "run-1", feature: "feat-1" },
    });
    expect(run.timeline?.status).toBe("crashed");
    expect(run.timeline?.stories.map((s) => s.storyId)).toEqual(["US-001", "US-002"]);
    expect(reference.stories.map((s) => s.storyId)).toEqual(["US-001", "US-002"]);
    expect(run.timeline?.stories.map((s) => s.phases)).toEqual(reference.stories.map((s) => s.phases));
  });

  test("AC1: a run with no resolvable log keeps the missing-log handling (empty report, exit 0)", async () => {
    const run = await runStreamed(null, interleavedMetrics());

    expect(run.exit).toBe(0);
    expect(run.index).toBeUndefined();
    expect(run.stdout).toContain("Stories: 3");
    expect(run.timeline?.stories.every((s) => s.phases.length === 0)).toBe(true);
  });

  test("AC1: a missing log file on disk is treated as an empty spine, not an error", async () => {
    const run = await runStreamed(join(dir, "absent.jsonl"), interleavedMetrics());

    expect(run.exit).toBe(0);
    expect(run.index?.recordsInspected).toBe(0);
    expect(run.timeline?.naxVersion).toBeUndefined();
  });

  test("AC1 boundary: the JSON form carries the same inferred stories", async () => {
    const run = await runStreamed(logPath, interleavedMetrics(), { json: true });
    const parsed = JSON.parse(run.stdout) as RunTimeline;

    expect(parsed.stories.map((s) => s.storyId)).toEqual(["US-001", "US-002", "US-003"]);
    expect(parsed.naxVersion).toBe("0.94.2");
  });
});

describe("runReplay — AC2: record inspections stay constant as stories grow", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = makeTempDir("nax-replay-stream-big-");
    const lines: string[] = [];
    for (let i = 0; i < RECORD_COUNT; i++) {
      const storyId = `US-${String(i % BIG_STORY_COUNT).padStart(3, "0")}`;
      const message = i % 2 === 0 ? "Phase passed: implementer" : "Phase passed: test-writer";
      lines.push(
        JSON.stringify({
          timestamp: TS,
          level: "info",
          stage: "story-orchestrator",
          storyId,
          message,
          data: { storyId },
        }),
      );
    }
    logPath = writeLog(dir, "big.jsonl", lines);
  });

  afterEach(() => cleanupTempDir(dir));

  function manyStoryMetrics(count: number): RunMetrics {
    return runMetrics(Array.from({ length: count }, (_, i) => storyMetrics(`US-${String(i).padStart(3, "0")}`, true)));
  }

  test("AC2: one story inspects each record once", async () => {
    const run = await runStreamed(logPath, manyStoryMetrics(1));

    expect(run.timeline?.stories).toHaveLength(1);
    expect(run.index?.recordsInspected).toBe(RECORD_COUNT);
  });

  test("AC2: 100 stories inspect each record once, not records times stories", async () => {
    const run = await runStreamed(logPath, manyStoryMetrics(BIG_STORY_COUNT));

    expect(run.timeline?.stories).toHaveLength(BIG_STORY_COUNT);
    // Every one of the 100 stories really did get its phases from the index —
    // the low inspection count is not the result of skipping reconstruction.
    expect(run.timeline?.stories.every((s) => s.phases.length > 0)).toBe(true);
    expect(run.index?.recordsInspected).toBe(RECORD_COUNT);
  });

  test("AC2: --story filtering inspects each record once as well", async () => {
    const run = await runStreamed(logPath, manyStoryMetrics(BIG_STORY_COUNT), { story: "US-007" });

    expect(run.stdout).toContain("US-007");
    expect(run.index?.recordsInspected).toBe(RECORD_COUNT);
  });

  test("AC2: reconstruction reads the accumulated buckets without rewalking the records", async () => {
    const index = await readReplayEvents(logPath);
    const afterIngest = index.recordsInspected;

    const timeline = reconstructTimeline({ events: index, runMetrics: manyStoryMetrics(BIG_STORY_COUNT) });

    expect(index.recordsInspected).toBe(afterIngest);
    expect(index.recordsInspected).toBe(RECORD_COUNT);
    expect(timeline.stories).toHaveLength(BIG_STORY_COUNT);
  });
});

describe("runReplay — AC7: a log path that cannot be streamed is reported", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-replay-stream-unsafe-");
  });

  afterEach(() => cleanupTempDir(dir));

  test("AC7: a symlinked log path is reported instead of producing a report", async () => {
    const target = writeLog(dir, "target.jsonl", toLines(interleavedSpine()));
    const link = join(dir, "run-1.jsonl");
    symlinkSync(target, link);

    const stdout: string[] = [];
    const deps: ReplayCommandDeps = {
      ..._replayCmdDeps,
      discoverRun: mock(async () => ({
        meta: {
          runId: "run-1",
          project: "demo",
          feature: "feat-1",
          workdir: "/tmp",
          statusPath: "/tmp/missing-status.json",
          eventsDir: dir,
          registeredAt: TS,
        },
        jsonlPath: link,
      })),
      readMetrics: mock(async () => interleavedMetrics()),
      readStatus: mock(async () => undefined),
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    };

    let reported = false;
    try {
      await runReplay("run-1", {}, deps);
    } catch {
      reported = true;
    }

    expect(reported).toBe(true);
    expect(stdout.join("")).toBe("");
  });

  test("AC7: a nonregular log path is reported with the registered-log error code", async () => {
    const sub = join(dir, "logs-dir");
    mkdirSync(sub);

    let thrown: unknown;
    try {
      await _replayCmdDeps.readEvents(sub);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toMatchObject({ code: "LOG_NOT_REGULAR_FILE" });
  });
});
