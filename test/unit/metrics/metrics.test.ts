import { describe, expect, test } from "bun:test";
import { type RunMetrics, type StoryMetrics, calculateAggregateMetrics, getLastRun } from "../../../src/metrics";

describe("metrics/aggregator", () => {
  describe("calculateAggregateMetrics", () => {
    test("returns empty metrics for no runs", () => {
      const aggregate = calculateAggregateMetrics([]);

      expect(aggregate.totalRuns).toBe(0);
      expect(aggregate.totalCost).toBe(0);
      expect(aggregate.totalStories).toBe(0);
      expect(aggregate.firstPassRate).toBe(0);
      expect(aggregate.escalationRate).toBe(0);
      expect(aggregate.avgCostPerStory).toBe(0);
      expect(aggregate.avgCostPerFeature).toBe(0);
      expect(Object.keys(aggregate.modelEfficiency)).toHaveLength(0);
      expect(Object.keys(aggregate.complexityAccuracy)).toHaveLength(0);
    });

    test("calculates metrics for single run", () => {
      const storyMetrics: StoryMetrics[] = [
        {
          storyId: "US-001",
          complexity: "simple",
          modelTier: "fast",
          modelUsed: "claude-haiku-4.5",
          attempts: 1,
          finalTier: "fast",
          success: true,
          cost: 0.01,
          durationMs: 30000,
          firstPassSuccess: true,
          startedAt: "2026-02-17T10:00:00.000Z",
          completedAt: "2026-02-17T10:00:30.000Z",
        },
        {
          storyId: "US-002",
          complexity: "medium",
          modelTier: "balanced",
          modelUsed: "claude-sonnet-4.5",
          attempts: 2,
          finalTier: "powerful",
          success: true,
          cost: 0.05,
          durationMs: 60000,
          firstPassSuccess: false,
          startedAt: "2026-02-17T10:01:00.000Z",
          completedAt: "2026-02-17T10:02:00.000Z",
        },
      ];

      const runMetrics: RunMetrics = {
        runId: "run-test-1",
        feature: "test-feature",
        startedAt: "2026-02-17T10:00:00.000Z",
        completedAt: "2026-02-17T10:02:00.000Z",
        totalCost: 0.06,
        totalStories: 2,
        storiesCompleted: 2,
        storiesFailed: 0,
        totalDurationMs: 120000,
        stories: storyMetrics,
      };

      const aggregate = calculateAggregateMetrics([runMetrics]);

      expect(aggregate.totalRuns).toBe(1);
      expect(aggregate.totalCost).toBe(0.06);
      expect(aggregate.totalStories).toBe(2);
      expect(aggregate.firstPassRate).toBe(0.5); // 1/2
      expect(aggregate.escalationRate).toBe(0.5); // 1/2
      expect(aggregate.avgCostPerStory).toBe(0.03);
      expect(aggregate.avgCostPerFeature).toBe(0.06);
    });

    test("calculates model efficiency across multiple runs", () => {
      const run1: RunMetrics = {
        runId: "run-1",
        feature: "feature-1",
        startedAt: "2026-02-17T10:00:00.000Z",
        completedAt: "2026-02-17T10:01:00.000Z",
        totalCost: 0.02,
        totalStories: 2,
        storiesCompleted: 2,
        storiesFailed: 0,
        totalDurationMs: 60000,
        stories: [
          {
            storyId: "US-001",
            complexity: "simple",
            modelTier: "fast",
            modelUsed: "claude-haiku-4.5",
            attempts: 1,
            finalTier: "fast",
            success: true,
            cost: 0.01,
            durationMs: 30000,
            firstPassSuccess: true,
            startedAt: "2026-02-17T10:00:00.000Z",
            completedAt: "2026-02-17T10:00:30.000Z",
          },
          {
            storyId: "US-002",
            complexity: "simple",
            modelTier: "fast",
            modelUsed: "claude-haiku-4.5",
            attempts: 1,
            finalTier: "fast",
            success: true,
            cost: 0.01,
            durationMs: 30000,
            firstPassSuccess: true,
            startedAt: "2026-02-17T10:00:30.000Z",
            completedAt: "2026-02-17T10:01:00.000Z",
          },
        ],
      };

      const run2: RunMetrics = {
        runId: "run-2",
        feature: "feature-2",
        startedAt: "2026-02-17T11:00:00.000Z",
        completedAt: "2026-02-17T11:01:00.000Z",
        totalCost: 0.05,
        totalStories: 1,
        storiesCompleted: 1,
        storiesFailed: 0,
        totalDurationMs: 60000,
        stories: [
          {
            storyId: "US-003",
            complexity: "complex",
            modelTier: "powerful",
            modelUsed: "claude-opus-4.6",
            attempts: 1,
            finalTier: "powerful",
            success: true,
            cost: 0.05,
            durationMs: 60000,
            firstPassSuccess: true,
            startedAt: "2026-02-17T11:00:00.000Z",
            completedAt: "2026-02-17T11:01:00.000Z",
          },
        ],
      };

      const aggregate = calculateAggregateMetrics([run1, run2]);

      expect(aggregate.totalRuns).toBe(2);
      expect(aggregate.totalStories).toBe(3);

      // Check haiku model efficiency
      expect(aggregate.modelEfficiency["claude-haiku-4.5"]).toBeDefined();
      expect(aggregate.modelEfficiency["claude-haiku-4.5"].attempts).toBe(2);
      expect(aggregate.modelEfficiency["claude-haiku-4.5"].successes).toBe(2);
      expect(aggregate.modelEfficiency["claude-haiku-4.5"].passRate).toBe(1.0);
      expect(aggregate.modelEfficiency["claude-haiku-4.5"].totalCost).toBe(0.02);

      // Check opus model efficiency
      expect(aggregate.modelEfficiency["claude-opus-4.6"]).toBeDefined();
      expect(aggregate.modelEfficiency["claude-opus-4.6"].attempts).toBe(1);
      expect(aggregate.modelEfficiency["claude-opus-4.6"].successes).toBe(1);
      expect(aggregate.modelEfficiency["claude-opus-4.6"].passRate).toBe(1.0);
      expect(aggregate.modelEfficiency["claude-opus-4.6"].totalCost).toBe(0.05);
    });

    test("calculates complexity accuracy with mismatches", () => {
      const runMetrics: RunMetrics = {
        runId: "run-test-1",
        feature: "test-feature",
        startedAt: "2026-02-17T10:00:00.000Z",
        completedAt: "2026-02-17T10:05:00.000Z",
        totalCost: 0.15,
        totalStories: 3,
        storiesCompleted: 3,
        storiesFailed: 0,
        totalDurationMs: 300000,
        stories: [
          {
            storyId: "US-001",
            complexity: "simple",
            modelTier: "fast",
            modelUsed: "claude-haiku-4.5",
            attempts: 1,
            finalTier: "fast",
            success: true,
            cost: 0.01,
            durationMs: 30000,
            firstPassSuccess: true,
            startedAt: "2026-02-17T10:00:00.000Z",
            completedAt: "2026-02-17T10:00:30.000Z",
          },
          {
            storyId: "US-002",
            complexity: "simple",
            modelTier: "fast",
            modelUsed: "claude-sonnet-4.5",
            attempts: 2,
            finalTier: "balanced",
            success: true,
            cost: 0.04,
            durationMs: 120000,
            firstPassSuccess: false,
            startedAt: "2026-02-17T10:01:00.000Z",
            completedAt: "2026-02-17T10:03:00.000Z",
          },
          {
            storyId: "US-003",
            complexity: "medium",
            modelTier: "balanced",
            modelUsed: "claude-sonnet-4.5",
            attempts: 1,
            finalTier: "balanced",
            success: true,
            cost: 0.03,
            durationMs: 90000,
            firstPassSuccess: true,
            startedAt: "2026-02-17T10:03:00.000Z",
            completedAt: "2026-02-17T10:04:30.000Z",
          },
        ],
      };

      const aggregate = calculateAggregateMetrics([runMetrics]);

      // Check simple complexity accuracy
      expect(aggregate.complexityAccuracy.simple).toBeDefined();
      expect(aggregate.complexityAccuracy.simple.predicted).toBe(2);
      expect(aggregate.complexityAccuracy.simple.mismatchRate).toBe(0.5); // 1 mismatch out of 2

      // Check medium complexity accuracy
      expect(aggregate.complexityAccuracy.medium).toBeDefined();
      expect(aggregate.complexityAccuracy.medium.predicted).toBe(1);
      expect(aggregate.complexityAccuracy.medium.mismatchRate).toBe(0); // no mismatch
    });
  });

  describe("getLastRun", () => {
    test("returns null for empty runs", () => {
      expect(getLastRun([])).toBeNull();
    });

    test("returns last run from array", () => {
      const runs: RunMetrics[] = [
        {
          runId: "run-1",
          feature: "feature-1",
          startedAt: "2026-02-17T10:00:00.000Z",
          completedAt: "2026-02-17T10:01:00.000Z",
          totalCost: 0.01,
          totalStories: 1,
          storiesCompleted: 1,
          storiesFailed: 0,
          totalDurationMs: 60000,
          stories: [],
        },
        {
          runId: "run-2",
          feature: "feature-2",
          startedAt: "2026-02-17T11:00:00.000Z",
          completedAt: "2026-02-17T11:01:00.000Z",
          totalCost: 0.02,
          totalStories: 2,
          storiesCompleted: 2,
          storiesFailed: 0,
          totalDurationMs: 120000,
          stories: [],
        },
      ];

      const lastRun = getLastRun(runs);
      expect(lastRun).not.toBeNull();
      expect(lastRun?.runId).toBe("run-2");
    });
  });
});
