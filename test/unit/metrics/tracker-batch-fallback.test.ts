/**
 * collectBatchMetrics — agent-swap hops and crash retries (nax#1709 follow-up).
 *
 * nax#1711 wired the run-scoped `runtime.agentFallbacks` / `runtime.runtimeCrashRetries`
 * stores into the sequential success path (collectStoryMetrics), the failure back-fill
 * (synthesizeBackfillMetric) and the parallel path (synthesizeParallelStoryMetric).
 * Batch execution was the one remaining builder: it read neither store, so a swap that
 * happened while a batch was running was recorded by callOp and then discarded — the
 * run-level `totalWastedCostUsd` still omitted that spend for every batched story.
 *
 * Attribution: callOp keys hops by `ctx.story.id`, which in a batch is the batch's lead
 * story. Each story therefore looks up its OWN id, so the lead carries the hops and the
 * siblings carry none. That under-attributes per story but counts every hop exactly once
 * at run level, which is what the aggregate measures. Fabricating a share per sibling
 * would inflate totalHops and perPair.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeMockRuntime, makeNaxConfig, makePRD, makeStory, makeTestContext } from "@test/helpers";
import type { AgentFallbackRecord } from "@/agents/manager-types";
import { deriveRunFallbackAggregates } from "@/metrics/aggregator";
import { collectBatchMetrics } from "@/metrics/tracker";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd";

const WORKDIR = `/tmp/nax-test-batch-fallback-${randomUUID()}`;
const STORY_START_TIME = "2026-08-26T10:00:00.000Z";

function batchCtx(stories: UserStory[]): PipelineContext {
  return Object.assign(
    makeTestContext({
      config: makeNaxConfig(),
      prd: makePRD({ userStories: stories }),
      story: stories[0],
      stories,
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "test" },
      workdir: WORKDIR,
    }),
    {
      agentResult: { success: true, estimatedCostUsd: 0.01, durationMs: 1000 },
      runtime: makeMockRuntime(),
    },
  );
}

function hop(overrides: Partial<AgentFallbackRecord> = {}): AgentFallbackRecord {
  return {
    storyId: "US-001",
    priorAgent: "codex",
    newAgent: "claude",
    hop: 1,
    outcome: "fail-quota",
    category: "availability",
    timestamp: "2026-08-26T00:00:00.000Z",
    costUsd: 0.05,
    ...overrides,
  };
}

const twoStories = (): UserStory[] => [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })];

describe("collectBatchMetrics - agent-swap hops (nax#1709)", () => {
  test("surfaces hops recorded against the batch's lead story", () => {
    const stories = twoStories();
    const ctx = batchCtx(stories);
    ctx.runtime.agentFallbacks.set("US-001", [
      hop(),
      hop({ hop: 2, priorAgent: "claude", newAgent: "opencode", costUsd: 0.02 }),
    ]);

    const metrics = collectBatchMetrics(ctx, STORY_START_TIME);

    const lead = metrics.find((m) => m.storyId === "US-001");
    expect(lead?.fallback?.hops).toHaveLength(2);
    expect(lead?.fallback?.hops[0].priorAgent).toBe("codex");
    expect(lead?.fallback?.hops[1].costUsd).toBe(0.02);
  });

  test("a sibling with no recorded hops carries no fallback field", () => {
    const stories = twoStories();
    const ctx = batchCtx(stories);
    ctx.runtime.agentFallbacks.set("US-001", [hop()]);

    const metrics = collectBatchMetrics(ctx, STORY_START_TIME);

    expect(metrics.find((m) => m.storyId === "US-002")?.fallback).toBeUndefined();
  });

  test("each hop is counted exactly once by the run-level aggregate", () => {
    const stories = twoStories();
    const ctx = batchCtx(stories);
    ctx.runtime.agentFallbacks.set("US-001", [
      hop(),
      hop({ hop: 2, priorAgent: "claude", newAgent: "opencode", costUsd: 0.02 }),
    ]);

    const aggregate = deriveRunFallbackAggregates(collectBatchMetrics(ctx, STORY_START_TIME));

    expect(aggregate?.totalHops).toBe(2);
    expect(aggregate?.perPair).toEqual({ "codex->claude": 1, "claude->opencode": 1 });
    expect(aggregate?.totalWastedCostUsd).toBeCloseTo(0.07, 5);
  });

  test("hops keyed to a sibling are attributed to that sibling, not the lead", () => {
    const stories = twoStories();
    const ctx = batchCtx(stories);
    ctx.runtime.agentFallbacks.set("US-002", [hop({ storyId: "US-002" })]);

    const metrics = collectBatchMetrics(ctx, STORY_START_TIME);

    expect(metrics.find((m) => m.storyId === "US-001")?.fallback).toBeUndefined();
    expect(metrics.find((m) => m.storyId === "US-002")?.fallback?.hops).toHaveLength(1);
  });

  test("no swaps at all leaves every entry without a fallback field", () => {
    const metrics = collectBatchMetrics(batchCtx(twoStories()), STORY_START_TIME);

    for (const m of metrics) expect(m.fallback).toBeUndefined();
  });
});

describe("collectBatchMetrics - runtimeCrashes (nax#1709)", () => {
  test("reads the per-story crash tally instead of hardcoding zero", () => {
    const stories = twoStories();
    const ctx = batchCtx(stories);
    ctx.runtime.runtimeCrashRetries.set("US-001", 2);

    const metrics = collectBatchMetrics(ctx, STORY_START_TIME);

    expect(metrics.find((m) => m.storyId === "US-001")?.runtimeCrashes).toBe(2);
    expect(metrics.find((m) => m.storyId === "US-002")?.runtimeCrashes).toBe(0);
  });

  test("stays 0 for a batch where nothing crashed", () => {
    const metrics = collectBatchMetrics(batchCtx(twoStories()), STORY_START_TIME);

    for (const m of metrics) expect(m.runtimeCrashes).toBe(0);
  });
});
