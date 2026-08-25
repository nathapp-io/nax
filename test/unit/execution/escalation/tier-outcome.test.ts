/**
 * Tier Escalation Outcome Handlers — pause-reason persistence (nax#1582)
 *
 * Verifies the pause path appends a structured reason to `priorErrors`
 * instead of leaving it empty (which surfaces as "no reason recorded" in
 * the resume prompt).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "@/execution/escalation";
import type { EscalationHandlerContext } from "@/execution/escalation";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { cleanupTempDir, makeMockRuntime, makePRD, makeStory, makeTempDir } from "@test/helpers";

function makeCtx(overrides: Partial<EscalationHandlerContext>, prdPath: string): EscalationHandlerContext {
  const story = makeStory({ id: "US-001", status: "in-progress" });
  const prd = makePRD({ userStories: [story] });
  return {
    story,
    storiesToExecute: [story],
    isBatchExecution: false,
    routing: { modelTier: "fast", testStrategy: "test-after" },
    pipelineResult: { reason: "Rectification exhausted", context: {} },
    config: {} as EscalationHandlerContext["config"],
    prd,
    prdPath,
    featureDir: undefined,
    hooks: { hooks: {} } as EscalationHandlerContext["hooks"],
    feature: "f",
    totalCost: 0,
    workdir: "/tmp",
    ...overrides,
  } as EscalationHandlerContext;
}

describe("handleNoTierAvailable — pause-reason persistence (nax#1582)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-tier-outcome-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("appends the pause reason, including the pipeline diagnosis, to priorErrors instead of leaving it empty", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({}, prdPath);

    const result = await handleNoTierAvailable(ctx, "verifier-rejected");

    expect(result.outcome).toBe("paused");
    const pausedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(pausedStory?.priorErrors).toEqual([
      "PAUSED: Execution stopped (verifier-rejected requires human review): Rectification exhausted",
    ]);
  });

  test("omits the trailing colon when the pipeline result carries no reason", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({ pipelineResult: { reason: undefined, context: {} } }, prdPath);

    const result = await handleNoTierAvailable(ctx, "verifier-rejected");

    const pausedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(pausedStory?.priorErrors).toEqual(["PAUSED: Execution stopped (verifier-rejected requires human review)"]);
  });

  test("scrubs a fabricated quote in the pipeline reason before persisting (nax#930 convention)", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx(
      { pipelineResult: { reason: "src/does-not-exist.ts:1 says `this quote is fabricated`", context: {} } },
      prdPath,
    );

    const result = await handleNoTierAvailable(ctx, "verifier-rejected");

    const pausedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(pausedStory?.priorErrors?.[0]).toContain("<UNVERIFIED_QUOTE>");
    expect(pausedStory?.priorErrors?.[0]).not.toContain("this quote is fabricated");
  });
});

describe("handleMaxAttemptsReached — pause-reason persistence (nax#1582)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-tier-outcome-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("appends the pause reason, including the pipeline diagnosis, to priorErrors instead of leaving it empty", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({}, prdPath);

    const result = await handleMaxAttemptsReached(ctx, "runtime-crash");

    expect(result.outcome).toBe("paused");
    const pausedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(pausedStory?.priorErrors).toEqual([
      "PAUSED: Max attempts reached (runtime-crash requires human review): Rectification exhausted",
    ]);
  });
});

// ---------------------------------------------------------------------------
// nax#1707 follow-up: these emitters read
// `ctx.runtime?.costAggregator.byStory()[id]?.totalCostUsd ?? ctx.totalCost`. The only
// caller of handleTierEscalation never passed `runtime`, so the fallback was taken
// unconditionally and every paused story reported the RUN-WIDE total. Threading runtime
// switches them to per-story cost; the sibling emitter in preIterationTierCheck is
// already pinned both ways (tier-escalation-story-failed.test.ts), these four were not.
// ---------------------------------------------------------------------------

describe("handleNoTierAvailable — cost source on story:paused", () => {
  let tempDir: string;
  let unsubscribe: (() => void) | undefined;
  const seen: { cost?: number }[] = [];

  beforeEach(() => {
    tempDir = makeTempDir("nax-tier-outcome-cost-");
    seen.length = 0;
    unsubscribe = pipelineEventBus.on("story:paused", (event) => {
      seen.push({ cost: (event as { cost?: number }).cost });
    });
  });

  afterEach(() => {
    unsubscribe?.();
    cleanupTempDir(tempDir);
  });

  test("reports the per-story total from the aggregator, not the run-wide totalCost", async () => {
    const runtime = makeMockRuntime();
    runtime.costAggregator.record({
      ts: Date.now(),
      runId: "test-run",
      agentName: "claude",
      model: "test-model",
      storyId: "US-001",
      tokens: { input: 10, output: 10 },
      estimatedCostUsd: 0.75,
      exactCostUsd: 0.75,
      costUsd: 0.75,
      confidence: "estimated",
      durationMs: 100,
    });
    // Deliberately different from the per-story cost so a fallback read is visible.
    const ctx = makeCtx({ runtime, totalCost: 9.99 }, join(tempDir, "prd.json"));

    await handleNoTierAvailable(ctx, "verifier-rejected");

    expect(seen).toHaveLength(1);
    expect(seen[0].cost).toBe(0.75);
  });

  test("falls back to the run-wide totalCost when no runtime is threaded", async () => {
    const ctx = makeCtx({ totalCost: 9.99 }, join(tempDir, "prd.json"));

    await handleNoTierAvailable(ctx, "verifier-rejected");

    expect(seen).toHaveLength(1);
    expect(seen[0].cost).toBe(9.99);
  });
});
