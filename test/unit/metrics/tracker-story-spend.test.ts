/**
 * #1960 — StoryMetrics.cost is total spend, with the failed half beside it.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TEST_ROUTING,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTestContext,
} from "@test/helpers";
import { collectStoryMetrics } from "@/metrics/tracker";
import type { PipelineContext } from "@/pipeline/types";
import type { NaxRuntime } from "@/runtime";
import { CostAggregator } from "@/runtime/cost-aggregator";

function seedAggregator(): CostAggregator {
  const agg = new CostAggregator("r-001", "/tmp/drain");
  agg.record({
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    model: "m",
    tokens: { input: 10, output: 5 },
    estimatedCostUsd: 0.02,
    exactCostUsd: 0.02,
    costUsd: 0.02,
    confidence: "estimated",
    durationMs: 10,
    storyId: "US-001",
  });
  agg.recordError({
    kind: "error",
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    errorCode: "DISPATCH_ERROR",
    durationMs: 5,
    storyId: "US-001",
    costUsd: 0.005,
  });
  return agg;
}

/**
 * Same context shape tracker-provider-cost.test.ts builds: makeTestContext
 * plus a runtime (real CostAggregator injected). projectDir points at a
 * nonexistent "/repo", so deriveContextMetrics finds no manifests and omits
 * context — cost reads are the only thing under test.
 */
function makeCtx({ runtime }: { runtime: NaxRuntime }): PipelineContext {
  return Object.assign(
    makeTestContext({
      story: makeStory({ id: "US-001", title: "Test Story" }),
      prd: makePRD({ feature: "test-feature", project: "test", branchName: "main" }),
      config: makeNaxConfig({ agent: { default: "claude" } }),
      projectDir: "/repo",
      workdir: "/repo",
      routing: { ...DEFAULT_TEST_ROUTING, modelTier: "balanced" },
    }),
    { agentResult: { success: true, cost: 0 }, runtime },
  );
}

describe("StoryMetrics spend shape (#1960)", () => {
  test("cost folds failed-dispatch spend and errorCostUsd carries the failed half", async () => {
    const agg = seedAggregator();
    const runtime = makeMockRuntime({ costAggregator: agg });

    // Guard the seam the tracker reads through, so this fails loudly if
    // byStory stops keying error rows.
    expect(agg.byStory()["US-001"]?.totalCostUsd).toBe(0.02);
    expect(agg.byStory()["US-001"]?.totalErrorCostUsd).toBe(0.005);

    const metric = await collectStoryMetrics(makeCtx({ runtime }), new Date().toISOString());

    expect(metric.cost).toBe(0.025);
    expect(metric.errorCostUsd).toBe(0.005);
  });

  test("errorCostUsd is absent when nothing threw", async () => {
    const agg = new CostAggregator("r-002", "/tmp/drain");
    agg.record({
      ts: Date.now(),
      runId: "r-002",
      agentName: "claude",
      model: "m",
      tokens: { input: 10, output: 5 },
      estimatedCostUsd: 0.02,
      exactCostUsd: 0.02,
      costUsd: 0.02,
      confidence: "estimated",
      durationMs: 10,
      storyId: "US-001",
    });

    const metric = await collectStoryMetrics(
      makeCtx({ runtime: makeMockRuntime({ costAggregator: agg }) }),
      new Date().toISOString(),
    );

    expect(metric.cost).toBe(0.02);
    expect("errorCostUsd" in metric).toBe(false);
  });
});
