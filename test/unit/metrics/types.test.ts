/**
 * TokenUsage and Metrics Extensions — US-001
 *
 * AC-1: TokenUsage interface with input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens?
 * AC-2: StoryMetrics has optional tokens?: TokenUsage
 * AC-3: RunMetrics has optional totalTokens?: TokenUsage
 * AC-4: TokenUsage re-exported from src/metrics/index.ts barrel
 * AC-6: When cache fields are 0 or undefined, they are omitted from TokenUsage instances
 */

import { describe, expect, test } from "bun:test";
import type { RunMetrics, StoryMetrics, TokenUsage } from "../../../src/metrics/types";

// ---------------------------------------------------------------------------
// AC-1: TokenUsage interface structure
// ---------------------------------------------------------------------------

describe("TokenUsage interface", () => {
  test("has required input_tokens and output_tokens fields", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
    };

    expect(usage.input_tokens).toBe(1000);
    expect(usage.output_tokens).toBe(500);
  });

  test("has optional cache_read_input_tokens field", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 300,
    };

    expect(usage.cache_read_input_tokens).toBe(300);
  });

  test("has optional cache_creation_input_tokens field", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 150,
    };

    expect(usage.cache_creation_input_tokens).toBe(150);
  });

  test("cache fields are optional and may be omitted", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
    };

    expect(usage.cache_read_input_tokens).toBeUndefined();
    expect(usage.cache_creation_input_tokens).toBeUndefined();
  });

  test("cache fields can be set to numbers including 0", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
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
      tokens: {
        input_tokens: 2000,
        output_tokens: 1000,
        cache_read_input_tokens: 500,
      },
    };

    expect(metrics.tokens).toBeDefined();
    expect(metrics.tokens?.input_tokens).toBe(2000);
    expect(metrics.tokens?.output_tokens).toBe(1000);
    expect(metrics.tokens?.cache_read_input_tokens).toBe(500);
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
      totalTokens: {
        input_tokens: 5000,
        output_tokens: 2500,
        cache_creation_input_tokens: 1000,
      },
    };

    expect(metrics.totalTokens).toBeDefined();
    expect(metrics.totalTokens?.input_tokens).toBe(5000);
    expect(metrics.totalTokens?.output_tokens).toBe(2500);
    expect(metrics.totalTokens?.cache_creation_input_tokens).toBe(1000);
  });
});
