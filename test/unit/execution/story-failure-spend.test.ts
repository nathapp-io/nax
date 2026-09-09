/**
 * #1960 — story:failed and story:paused report total spend.
 *
 * These eight sites are the concentration finding: they fire exactly where
 * failed-dispatch spend lands, and pre-#1960 they reported successful spend
 * only -- reporting 0 for a story whose every dispatch threw, because the
 * error row created the byStory key and killed the `?? ctx.totalCost` fallback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeEscalationContext, makeMockRuntime, makeTempDir } from "@test/helpers";
import type { EscalationHandlerContext } from "@/execution/escalation";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "@/execution/escalation";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { CostAggregator } from "@/runtime/cost-aggregator";

function errorOnlyAggregator(): CostAggregator {
  const agg = new CostAggregator("r-001", "/tmp/drain");
  agg.recordError({
    kind: "error",
    ts: Date.now(),
    runId: "r-001",
    agentName: "claude",
    errorCode: "DISPATCH_ERROR",
    durationMs: 5,
    storyId: "US-001",
    costUsd: 0.004,
  });
  return agg;
}

function successOnlyAggregator(): CostAggregator {
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
  return agg;
}

/**
 * Cast-free variant of the makeCtx in tier-outcome.test.ts, built on the shared
 * escalation-context helper (its inline `as`-casts are grandfathered there).
 */
function makeCtx(agg: CostAggregator, prdPath: string): EscalationHandlerContext {
  return makeEscalationContext({
    prdPath,
    pipelineResult: { reason: "Rectification exhausted", context: {} },
    // 99 is a sentinel: if the fallback fires when it must not, the assertion
    // below reports 99 instead of the story's real failed spend.
    totalCost: 99,
    runtime: makeMockRuntime({ costAggregator: agg }),
  });
}

function capture(type: "story:failed" | "story:paused") {
  const seen: Array<{ cost?: number; errorCostUsd?: number }> = [];
  const unsub = pipelineEventBus.on(type, (ev) => {
    seen.push({ cost: ev.cost, errorCostUsd: ev.errorCostUsd });
  });
  return { seen, unsub };
}

describe("failure-path spend (#1960)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-story-failure-spend-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("story:failed reports failed-dispatch spend for a story that only threw", async () => {
    const { seen, unsub } = capture("story:failed");
    // "tests-failing" maps to the fail outcome in resolveMaxAttemptsOutcome;
    // "verifier-rejected" takes the pause branch instead (#1960 swap contingency).
    await handleMaxAttemptsReached(makeCtx(errorOnlyAggregator(), join(tempDir, "prd.json")), "tests-failing");
    unsub();

    expect(seen[0]?.cost).toBe(0.004);
    expect(seen[0]?.errorCostUsd).toBe(0.004);
  });

  test("story:failed omits errorCostUsd when nothing threw", async () => {
    const { seen, unsub } = capture("story:failed");
    await handleMaxAttemptsReached(makeCtx(successOnlyAggregator(), join(tempDir, "prd.json")), "tests-failing");
    unsub();

    expect(seen[0]?.cost).toBe(0.02);
    expect(seen[0]?.errorCostUsd).toBeUndefined();
  });

  test("story:paused reports total spend too", async () => {
    const { seen, unsub } = capture("story:paused");
    await handleNoTierAvailable(makeCtx(errorOnlyAggregator(), join(tempDir, "prd.json")), "verifier-rejected");
    unsub();

    expect(seen[0]?.cost).toBe(0.004);
    expect(seen[0]?.errorCostUsd).toBe(0.004);
  });
});
