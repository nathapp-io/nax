/**
 * TokenUsage and Metrics Extensions — US-001
 *
 * AC-1: TokenUsage class with inputTokens, outputTokens, cacheReadInputTokens?, cacheCreationInputTokens?
 * AC-2: StoryMetrics has optional tokens?: TokenUsage
 * AC-3: RunMetrics has optional totalTokens?: TokenUsage
 * AC-4: TokenUsage re-exported from src/metrics/index.ts barrel
 * AC-6: When cache fields are 0 or undefined, they are omitted from TokenUsage instances
 */

import { describe, expect, test } from "bun:test";
import { TokenUsage } from "../../../src/metrics/types";
import type { RunMetrics, StoryMetrics } from "../../../src/metrics/types";

// ---------------------------------------------------------------------------
// AC-1: TokenUsage class structure
// ---------------------------------------------------------------------------

describe("TokenUsage class", () => {
  test("has required inputTokens and outputTokens fields", () => {
    const usage = new TokenUsage({ inputTokens: 1000, outputTokens: 500 });

    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(500);
  });

  test("has optional cacheReadInputTokens field", () => {
    const usage = new TokenUsage({ inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 300 });

    expect(usage.cacheReadInputTokens).toBe(300);
  });

  test("has optional cacheCreationInputTokens field", () => {
    const usage = new TokenUsage({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 150 });

    expect(usage.cacheCreationInputTokens).toBe(150);
  });

  test("cache fields are optional and may be omitted", () => {
    const usage = new TokenUsage({ inputTokens: 1000, outputTokens: 500 });

    expect(usage.cacheReadInputTokens).toBeUndefined();
    expect(usage.cacheCreationInputTokens).toBeUndefined();
  });

  test("cache fields can be set to numbers including 0", () => {
    const usage = new TokenUsage({ inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

    expect(usage.cacheReadInputTokens).toBe(0);
    expect(usage.cacheCreationInputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-2: StoryMetrics has optional tokens field
// ---------------------------------------------------------------------------

describe("StoryMetrics - tokens field", () => {
  test("tokens field is optional on StoryMetrics", () => {
    const metrics: StoryMetrics = {
      storyId: "US-001",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet-4-20250514",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.01,
      durationMs: 5000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    expect("tokens" in metrics).toBe(false);
  });

  test("tokens field can be set with TokenUsage", () => {
    const metrics: StoryMetrics = {
      storyId: "US-001",
      complexity: "medium",
      modelTier: "balanced",
      modelUsed: "claude-sonnet-4-20250514",
      attempts: 1,
      finalTier: "balanced",
      success: true,
      cost: 0.01,
      durationMs: 5000,
      firstPassSuccess: true,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      tokens: new TokenUsage({ inputTokens: 2000, outputTokens: 1000, cacheReadInputTokens: 500 }),
    };

    expect(metrics.tokens).toBeDefined();
    expect(metrics.tokens?.inputTokens).toBe(2000);
    expect(metrics.tokens?.outputTokens).toBe(1000);
    expect(metrics.tokens?.cacheReadInputTokens).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// AC-3: RunMetrics has optional totalTokens field
// ---------------------------------------------------------------------------

describe("RunMetrics - totalTokens field", () => {
  test("totalTokens field is optional on RunMetrics", () => {
    const metrics: RunMetrics = {
      runId: "run-001",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.05,
      totalStories: 3,
      storiesCompleted: 2,
      storiesFailed: 1,
      totalDurationMs: 30000,
      stories: [],
    };

    expect("totalTokens" in metrics).toBe(false);
  });

  test("totalTokens field can be set with TokenUsage", () => {
    const metrics: RunMetrics = {
      runId: "run-001",
      feature: "test-feature",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      totalCost: 0.05,
      totalStories: 3,
      storiesCompleted: 2,
      storiesFailed: 1,
      totalDurationMs: 30000,
      stories: [],
      totalTokens: new TokenUsage({ inputTokens: 5000, outputTokens: 2500, cacheCreationInputTokens: 1000 }),
    };

    expect(metrics.totalTokens).toBeDefined();
    expect(metrics.totalTokens?.inputTokens).toBe(5000);
    expect(metrics.totalTokens?.outputTokens).toBe(2500);
    expect(metrics.totalTokens?.cacheCreationInputTokens).toBe(1000);
  });
});
