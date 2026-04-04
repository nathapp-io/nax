/**
 * saveRunMetrics / loadRunMetrics — US-003: Aggregate totalTokens
 *
 * AC-1: saveRunMetrics() computes totalTokens by iterating over runMetrics.stories
 * AC-2: totalTokens.input_tokens equals sum of all story.tokens.input_tokens
 * AC-3: totalTokens.cache_read_input_tokens equals sum (undefined → 0)
 * AC-4: totalTokens.cache_creation_input_tokens equals sum (undefined → 0)
 * AC-5: When no stories have tokens data, totalTokens is absent from written output
 * AC-6: loadRunMetrics() handles existing metrics.json without totalTokens field
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadRunMetrics, saveRunMetrics } from "../../../src/metrics/tracker";
import type { RunMetrics, StoryMetrics } from "../../../src/metrics/types";
import { TokenUsage } from "../../../src/metrics/types";

const WORKDIR = `/tmp/nax-save-run-metrics-test-${randomUUID()}`;

async function setupWorkdir() {
  await mkdir(`${WORKDIR}/.nax`, { recursive: true });
}

async function cleanupWorkdir() {
  if (existsSync(WORKDIR)) {
    await rm(WORKDIR, { recursive: true, force: true });
  }
}

async function readMetricsFile(): Promise<RunMetrics[]> {
  const content = await readFile(`${WORKDIR}/.nax/metrics.json`, "utf-8");
  return JSON.parse(content);
}

beforeEach(async () => {
  await setupWorkdir();
});

afterEach(async () => {
  await cleanupWorkdir();
});

describe("saveRunMetrics - totalTokens aggregation", () => {
  test("AC-1 & AC-2: computes totalTokens.input_tokens as sum of story tokens", async () => {
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
      tokens: new TokenUsage({ input_tokens: 1000, output_tokens: 500 }),
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
      tokens: new TokenUsage({ input_tokens: 2000, output_tokens: 800 }),
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

    await saveRunMetrics(WORKDIR, runMetrics);

    const saved = await readMetricsFile();
    expect(saved).toHaveLength(1);
    expect(saved[0].totalTokens).toBeDefined();
    expect(saved[0].totalTokens?.input_tokens).toBe(3000);
    expect(saved[0].totalTokens?.output_tokens).toBe(1300);
  });

  test("AC-3: totalTokens.cache_read_input_tokens sums undefined as 0", async () => {
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
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 100,
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
        input_tokens: 2000,
        output_tokens: 800,
        cache_creation_input_tokens: 50,
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

    await saveRunMetrics(WORKDIR, runMetrics);

    const saved = await readMetricsFile();
    expect(saved).toHaveLength(1);
    expect(saved[0].totalTokens).toBeDefined();
    expect(saved[0].totalTokens?.cache_read_input_tokens).toBe(100);
    expect(saved[0].totalTokens?.cache_creation_input_tokens).toBe(50);
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
      tokens: new TokenUsage({ input_tokens: 0, output_tokens: 0 }),
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

    await saveRunMetrics(WORKDIR, runMetrics);

    const saved = await readMetricsFile();
    expect(saved).toHaveLength(1);
    expect(saved[0].totalTokens).toBeUndefined();
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

    await writeFile(`${WORKDIR}/.nax/metrics.json`, JSON.stringify(existingMetrics, null, 2));

    const runs = await loadRunMetrics(WORKDIR);

    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-old-001");
    expect(runs[0].totalTokens).toBeUndefined();
    expect(runs[0].stories).toHaveLength(1);
    expect(runs[0].stories[0].tokens).toBeUndefined();
  });
});
