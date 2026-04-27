/**
 * Metrics Tracker — runtimeCrashes Counter (BUG-070)
 *
 * Tests that story metrics track how many times a story was retried due to
 * a Bun runtime crash (RUNTIME_CRASH verify status), separately from
 * intentional escalations caused by test failures.
 *
 * Tests are RED until:
 * - StoryMetrics gains a runtimeCrashes?: number field in types.ts
 * - PipelineContext gains a storyRuntimeCrashes?: number field in pipeline/types.ts
 * - collectStoryMetrics() reads ctx.storyRuntimeCrashes and writes it to metrics
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../src/config";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../src/prd";
import { collectStoryMetrics } from "../../../src/metrics/tracker";
import { makeNaxConfig } from "../../helpers";

const WORKDIR = `/tmp/nax-test-metrics-${randomUUID()}`;
const WORKDIR_BATCH = `/tmp/nax-test-metrics-batch-${randomUUID()}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Test Story",
    description: "Test description",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "passed",
    passes: true,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

function makePRD(story: UserStory): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };
}

function makeContext(story: UserStory, overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    config: makeNaxConfig(),
    prd: makePRD(story),
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "test",
    },
    workdir: WORKDIR,
    hooks: { hooks: {} },
    ...overrides,
  } as PipelineContext;
}

const STORY_START_TIME = "2026-03-10T10:00:00.000Z";

// ---------------------------------------------------------------------------
// runtimeCrashes field in StoryMetrics
// ---------------------------------------------------------------------------

describe("collectStoryMetrics - runtimeCrashes field", () => {
  test("runtimeCrashes is 0 when no crashes occurred", async () => {
    const story = makeStory();
    const ctx = makeContext(story);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).toBe(0);
  });

  test("runtimeCrashes reflects count from ctx.storyRuntimeCrashes", async () => {
    const story = makeStory({ status: "passed", passes: true });
    const ctx = makeContext(story, { storyRuntimeCrashes: 2 });

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).toBe(2);
  });

  test("runtimeCrashes is 1 for a single crash retry", async () => {
    const story = makeStory({ status: "passed", passes: true });
    const ctx = makeContext(story, { storyRuntimeCrashes: 1 });

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).toBe(1);
  });

  test("runtimeCrashes is independent of story.escalations count", async () => {
    // A story can have 2 escalations (tier changes) AND 3 crash retries — tracked separately
    const story = makeStory({
      status: "passed",
      passes: true,
      escalations: [
        { fromTier: "fast", toTier: "balanced", reason: "tests-failing", timestamp: new Date().toISOString() },
        { fromTier: "balanced", toTier: "thorough", reason: "tests-failing", timestamp: new Date().toISOString() },
      ],
    });
    const ctx = makeContext(story, { storyRuntimeCrashes: 3 });

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).toBe(3);
    expect(metrics.attempts).toBeGreaterThan(0); // escalations still recorded
  });

  test("runtimeCrashes defaults to 0 when ctx.storyRuntimeCrashes is undefined", async () => {
    const story = makeStory();
    const ctx = makeContext(story);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    expect(metrics.runtimeCrashes).not.toBeUndefined();
    expect(metrics.runtimeCrashes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// StoryMetrics type — runtimeCrashes field presence
// ---------------------------------------------------------------------------

describe("StoryMetrics type — runtimeCrashes field", () => {
  test("collectStoryMetrics output includes runtimeCrashes as a number", async () => {
    const story = makeStory();
    const ctx = makeContext(story);

    const metrics = await collectStoryMetrics(ctx, STORY_START_TIME);

    // Must be a number (0 when no crashes), not undefined or string
    expect(typeof metrics.runtimeCrashes).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// collectBatchMetrics — runtimeCrashes per story
// ---------------------------------------------------------------------------

describe("collectBatchMetrics - runtimeCrashes per story", () => {
  test("batch stories have runtimeCrashes set to 0 (no individual crash tracking)", async () => {
    const { collectBatchMetrics } = await import("../../../src/metrics/tracker");

    const stories = [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })];
    const ctx = {
      config: makeNaxConfig(),
      prd: makePRD(stories[0]),
      story: stories[0],
      stories,
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "test",
      },
      workdir: WORKDIR_BATCH,
      hooks: { hooks: {} },
      agentResult: { success: true, estimatedCostUsd: 0.01, durationMs: 1000 },
    } as PipelineContext;

    const batchMetrics = collectBatchMetrics(ctx, STORY_START_TIME);

    for (const m of batchMetrics) {
      expect(m.runtimeCrashes).toBe(0);
    }
  });
});
