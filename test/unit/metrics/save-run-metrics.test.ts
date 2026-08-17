/**
 * saveRunMetrics / loadRunMetrics — US-003: Aggregate totalTokens
 *
 * AC-1: saveRunMetrics() computes totalTokens by iterating over runMetrics.stories
 * AC-2: totalTokens.inputTokens equals sum of all story.tokens.inputTokens
 * AC-3: totalTokens.cacheReadInputTokens equals sum (undefined → 0)
 * AC-4: totalTokens.cacheCreationInputTokens equals sum (undefined → 0)
 * AC-5: When no stories have tokens data, totalTokens is absent from written output
 * AC-6: loadRunMetrics() handles existing metrics.json without totalTokens field
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { addSink, initLogger, resetLogger } from "../../../src/logger";
import type { LogEntry } from "../../../src/logger";
import {
  MAX_RETAINED_RUNS,
  _resetRunTruncationWarningForTests,
  loadRunMetrics,
  saveRunMetrics,
} from "../../../src/metrics/tracker";
import type { RunMetrics, StoryMetrics } from "../../../src/metrics/types";
import { TokenUsage } from "../../../src/metrics/types";

// OUTPUT_DIR plays the role of outputDir (e.g. ~/.nax/<projectKey>): metrics are written
// directly to OUTPUT_DIR/metrics.json, no .nax/ subdirectory.
const OUTPUT_DIR = `/tmp/nax-save-run-metrics-test-${randomUUID()}`;

async function setupWorkdir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

async function cleanupWorkdir() {
  if (existsSync(OUTPUT_DIR)) {
    await rm(OUTPUT_DIR, { recursive: true, force: true });
  }
}

async function readMetricsFile(): Promise<RunMetrics[]> {
  const content = await readFile(`${OUTPUT_DIR}/metrics.json`, "utf-8");
  return JSON.parse(content);
}

beforeEach(async () => {
  await setupWorkdir();
});

afterEach(async () => {
  await cleanupWorkdir();
});

describe("saveRunMetrics - totalTokens aggregation", () => {
  test("AC-1 & AC-2: computes totalTokens.inputTokens as sum of story tokens", async () => {
    const story1: StoryMetrics = {
      storyId: "US-001",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet-4",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.01,
      durationMs: 5000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokens: new TokenUsage({ inputTokens: 1000, outputTokens: 500 }),
    };

    const story2: StoryMetrics = {
      storyId: "US-002",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet-4",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.02,
      durationMs: 6000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokens: new TokenUsage({ inputTokens: 2000, outputTokens: 800 }),
    };

    const runMetrics: RunMetrics = {
      runId: "run-001",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.03,
      totalStories: 2,
      storiesCompleted: 2,
      storiesFailed: 0,
      totalDurationMs: 11000,
      stories: [story1, story2],
    };

    await saveRunMetrics(OUTPUT_DIR, runMetrics);

    const saved = await readMetricsFile();
    expect(saved).toHaveLength(1);
    expect(saved[0].totalTokens).toBeDefined();
    expect(saved[0].totalTokens?.inputTokens).toBe(3000);
    expect(saved[0].totalTokens?.outputTokens).toBe(1300);
  });

  test("AC-3: totalTokens.cacheReadInputTokens sums undefined as 0", async () => {
    const story1: StoryMetrics = {
      storyId: "US-001",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet-4",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.01,
      durationMs: 5000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokens: new TokenUsage({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 100,
      }),
    };

    const story2: StoryMetrics = {
      storyId: "US-002",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet-4",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.02,
      durationMs: 6000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokens: new TokenUsage({
        inputTokens: 2000,
        outputTokens: 800,
        cacheCreationInputTokens: 50,
      }),
    };

    const runMetrics: RunMetrics = {
      runId: "run-002",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.03,
      totalStories: 2,
      storiesCompleted: 2,
      storiesFailed: 0,
      totalDurationMs: 11000,
      stories: [story1, story2],
    };

    await saveRunMetrics(OUTPUT_DIR, runMetrics);

    const saved = await readMetricsFile();
    expect(saved).toHaveLength(1);
    expect(saved[0].totalTokens).toBeDefined();
    expect(saved[0].totalTokens?.cacheReadInputTokens).toBe(100);
    expect(saved[0].totalTokens?.cacheCreationInputTokens).toBe(50);
  });

  test("AC-5: when no stories have tokens data, totalTokens is absent", async () => {
    const story1: StoryMetrics = {
      storyId: "US-001",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet-4",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.01,
      durationMs: 5000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokens: new TokenUsage({ inputTokens: 0, outputTokens: 0 }),
    };

    const story2: StoryMetrics = {
      storyId: "US-002",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet-4",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.02,
      durationMs: 6000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const runMetrics: RunMetrics = {
      runId: "run-003",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.03,
      totalStories: 2,
      storiesCompleted: 2,
      storiesFailed: 0,
      totalDurationMs: 11000,
      stories: [story1, story2],
    };

    await saveRunMetrics(OUTPUT_DIR, runMetrics);

    const saved = await readMetricsFile();
    expect(saved).toHaveLength(1);
    expect(saved[0].totalTokens).toBeUndefined();
  });
});

describe("saveRunMetrics - history cap (GROWTH-1)", () => {
  function makeMinimalRun(runId: string): RunMetrics {
    return {
      runId,
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.01,
      totalStories: 1,
      storiesCompleted: 1,
      storiesFailed: 0,
      totalDurationMs: 1000,
      stories: [
        {
          storyId: "US-001",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4",
          attempts: 1,
          finalTier: "balanced",
          success: true,
          cost: 0.01,
          durationMs: 1000,
          firstPassSuccess: true,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ],
    };
  }

  test("drops the oldest run when writing past MAX_RETAINED_RUNS", async () => {
    // Pre-seed metrics.json with exactly MAX_RETAINED_RUNS runs, oldest first.
    const seeded: RunMetrics[] = Array.from({ length: MAX_RETAINED_RUNS }, (_, i) => makeMinimalRun(`run-seed-${i}`));
    await writeFile(`${OUTPUT_DIR}/metrics.json`, JSON.stringify(seeded, null, 2));

    // Writing one more run should push the history past the cap.
    await saveRunMetrics(OUTPUT_DIR, makeMinimalRun("run-new"));

    const saved = await readMetricsFile();

    // History stays capped at MAX_RETAINED_RUNS, not MAX_RETAINED_RUNS + 1.
    expect(saved).toHaveLength(MAX_RETAINED_RUNS);
    // The oldest run (run-seed-0) was dropped.
    expect(saved.some((r) => r.runId === "run-seed-0")).toBe(false);
    // The newest run is retained.
    expect(saved[saved.length - 1]?.runId).toBe("run-new");
    // The second-oldest seeded run survives (only one was dropped).
    expect(saved.some((r) => r.runId === "run-seed-1")).toBe(true);
  });

  test("does not truncate history when at or under MAX_RETAINED_RUNS", async () => {
    const seeded: RunMetrics[] = Array.from({ length: MAX_RETAINED_RUNS - 1 }, (_, i) =>
      makeMinimalRun(`run-seed-${i}`),
    );
    await writeFile(`${OUTPUT_DIR}/metrics.json`, JSON.stringify(seeded, null, 2));

    await saveRunMetrics(OUTPUT_DIR, makeMinimalRun("run-new"));

    const saved = await readMetricsFile();
    expect(saved).toHaveLength(MAX_RETAINED_RUNS);
    expect(saved.some((r) => r.runId === "run-seed-0")).toBe(true);
  });

  describe("truncation warning (GROWTH-1 follow-up)", () => {
    let logCalls: LogEntry[];

    beforeEach(() => {
      resetLogger();
      logCalls = [];
      initLogger({ level: "silent" });
      addSink((entry) => logCalls.push(entry));
      // The warning is a one-shot, module-lifetime flag — reset it so this
      // suite is independent of whether an earlier test already tripped it
      // (e.g. "drops the oldest run..." above).
      _resetRunTruncationWarningForTests();
    });

    afterEach(() => {
      resetLogger();
    });

    test("logs a warn with the dropped-run count when the cap is first exceeded", async () => {
      const seeded: RunMetrics[] = Array.from({ length: MAX_RETAINED_RUNS }, (_, i) => makeMinimalRun(`run-seed-${i}`));
      await writeFile(`${OUTPUT_DIR}/metrics.json`, JSON.stringify(seeded, null, 2));

      await saveRunMetrics(OUTPUT_DIR, makeMinimalRun("run-new"));

      const warnCalls = logCalls.filter((e) => e.level === "warn" && e.stage === "metrics");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]?.data?.droppedCount).toBe(1);
      expect(warnCalls[0]?.data?.maxRetainedRuns).toBe(MAX_RETAINED_RUNS);
    });

    test("does not warn when at or under MAX_RETAINED_RUNS", async () => {
      const seeded: RunMetrics[] = Array.from({ length: MAX_RETAINED_RUNS - 1 }, (_, i) =>
        makeMinimalRun(`run-seed-${i}`),
      );
      await writeFile(`${OUTPUT_DIR}/metrics.json`, JSON.stringify(seeded, null, 2));

      await saveRunMetrics(OUTPUT_DIR, makeMinimalRun("run-new"));

      const warnCalls = logCalls.filter((e) => e.level === "warn" && e.stage === "metrics");
      expect(warnCalls).toHaveLength(0);
    });

    test("warns only once across repeated truncating saves (one-shot dedupe)", async () => {
      const seeded: RunMetrics[] = Array.from({ length: MAX_RETAINED_RUNS }, (_, i) => makeMinimalRun(`run-seed-${i}`));
      await writeFile(`${OUTPUT_DIR}/metrics.json`, JSON.stringify(seeded, null, 2));

      // Two saves in a row both push past the cap.
      await saveRunMetrics(OUTPUT_DIR, makeMinimalRun("run-new-1"));
      await saveRunMetrics(OUTPUT_DIR, makeMinimalRun("run-new-2"));

      const warnCalls = logCalls.filter((e) => e.level === "warn" && e.stage === "metrics");
      expect(warnCalls).toHaveLength(1);
    });
  });
});

describe("saveRunMetrics - concurrent writers (BUG-6)", () => {
  test("parallel saves preserve every appended run (no lost-update)", async () => {
    const writerCount = 6;
    const metrics = Array.from(
      { length: writerCount },
      (_, i) =>
        ({
          runId: `concurrent-${i}`,
          feature: "test-feature",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          totalCost: 0.01,
          totalStories: 1,
          storiesCompleted: 1,
          storiesFailed: 0,
          totalDurationMs: 1000,
          stories: [
            {
              storyId: "US-001",
              complexity: "medium",
              modelTier: "balanced",
              modelUsed: "claude-sonnet-4",
              attempts: 1,
              finalTier: "balanced",
              success: true,
              cost: 0.01,
              durationMs: 1000,
              firstPassSuccess: true,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            },
          ],
        }) satisfies RunMetrics,
    );

    await Promise.all(metrics.map((m) => saveRunMetrics(OUTPUT_DIR, m)));

    const saved = await readMetricsFile();
    expect(saved).toHaveLength(writerCount);
    const ids = saved.map((s) => s.runId).sort();
    expect(ids).toEqual(metrics.map((m) => m.runId).sort());
  });
});

describe("loadRunMetrics - backward compatibility", () => {
  test("AC-6: successfully loads metrics.json without totalTokens field", async () => {
    const existingMetrics = [
      {
        runId: "run-old-001",
        feature: "old-feature",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        totalCost: 0.05,
        totalStories: 1,
        storiesCompleted: 1,
        storiesFailed: 0,
        totalDurationMs: 5000,
        stories: [
          {
            storyId: "US-001",
            complexity: "medium",
            modelTier: "balanced",
            modelUsed: "claude-sonnet-4",
            attempts: 1,
            finalTier: "balanced",
            success: true,
            cost: 0.05,
            durationMs: 5000,
            firstPassSuccess: true,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        ],
      },
    ];

    await writeFile(`${OUTPUT_DIR}/metrics.json`, JSON.stringify(existingMetrics, null, 2));

    const runs = await loadRunMetrics(OUTPUT_DIR);

    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-old-001");
    expect(runs[0].totalTokens).toBeUndefined();
    expect(runs[0].stories).toHaveLength(1);
    expect(runs[0].stories[0].tokens).toBeUndefined();
  });
});
