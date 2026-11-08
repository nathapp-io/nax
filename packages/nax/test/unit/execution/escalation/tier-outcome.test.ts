/**
 * Tier Escalation Outcome Handlers — the exhausted-tier outcome is always a failure
 *
 * US-001: the pause branch is gone. Both handlers take the context and nothing
 * else, always mark the story failed and always emit `story:failed` — never
 * `story:paused`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeMockRuntime, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { EscalationHandlerContext } from "@/execution/escalation";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "@/execution/escalation";
import { pipelineEventBus } from "@/pipeline/event-bus";

/**
 * Compile-time pin (US-001): both handlers take the context and nothing else.
 * The failure-category parameter is gone, so no caller can route a story to the
 * pause branch. `bun run typecheck` is the gate that enforces it.
 */
type AssertTrue<T extends true> = T;
type AssertMaxAttemptsTakesOnlyTheContext = AssertTrue<
  Parameters<typeof handleMaxAttemptsReached>["length"] extends 1 ? true : false
>;
type AssertNoTierTakesOnlyTheContext = AssertTrue<
  Parameters<typeof handleNoTierAvailable>["length"] extends 1 ? true : false
>;

const _maxAttemptsTakesOnlyTheContext: AssertMaxAttemptsTakesOnlyTheContext = true;
const _noTierTakesOnlyTheContext: AssertNoTierTakesOnlyTheContext = true;

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

describe("handleNoTierAvailable — fail outcome and progress logging", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-tier-outcome-fail-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // AC-7 (outcome) and the failure transition itself.
  test("marks the story failed (not paused)", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({}, prdPath);
    expect(ctx.story.status).toBe("in-progress");

    const result = await handleNoTierAvailable(ctx);

    expect(result.outcome).toBe("failed");
    const failedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(failedStory?.status).toBe("failed");
  });

  test("marks the story failed with no failureCategory at all", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({}, prdPath);

    const result = await handleNoTierAvailable(ctx);

    expect(result.outcome).toBe("failed");
    const failedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(Object.hasOwn(failedStory ?? {}, "failureCategory")).toBe(false);
  });

  test("appends a failed progress entry when featureDir is set", async () => {
    const prdPath = join(tempDir, "prd.json");
    const featureDir = join(tempDir, "feature");
    const ctx = makeCtx({ featureDir }, prdPath);

    await handleNoTierAvailable(ctx);

    const progress = await readFile(join(featureDir, "progress.txt"), "utf8");
    expect(progress).toContain("FAILED");
    expect(progress).toContain("Execution failed");
  });

  test("emits a story:failed event with countsTowardEscalation", async () => {
    const seen: unknown[] = [];
    const unsubscribe = pipelineEventBus.on("story:failed", (event) => {
      seen.push(event);
    });
    try {
      const prdPath = join(tempDir, "prd.json");
      const ctx = makeCtx({}, prdPath);

      await handleNoTierAvailable(ctx);

      expect(seen).toHaveLength(1);
      expect((seen[0] as { countsTowardEscalation?: boolean }).countsTowardEscalation).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  // AC-8: exactly one terminal event, and it is the failure.
  test("AC-8: emits exactly one story:failed event with reason 'Execution failed'", async () => {
    const seen: Array<{ reason?: string }> = [];
    const unsubscribe = pipelineEventBus.on("story:failed", (event) => {
      seen.push({ reason: event.reason });
    });
    try {
      const prdPath = join(tempDir, "prd.json");
      const ctx = makeCtx({}, prdPath);

      await handleNoTierAvailable(ctx);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.reason).toBe("Execution failed");
    } finally {
      unsubscribe();
    }
  });

  // AC-9: the pause branch is unreachable.
  test("AC-9: emits no story:paused event", async () => {
    const seen: unknown[] = [];
    const unsubscribe = pipelineEventBus.on("story:paused", (event) => {
      seen.push(event);
    });
    try {
      const prdPath = join(tempDir, "prd.json");
      const ctx = makeCtx({}, prdPath);

      await handleNoTierAvailable(ctx);

      expect(seen).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});

describe("handleMaxAttemptsReached — fail outcome and progress logging", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-tier-outcome-max-fail-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // AC-1 (outcome) and AC-3 (the failed transition on the returned PRD).
  test("marks the story failed (not paused)", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({}, prdPath);
    expect(ctx.story.status).toBe("in-progress");

    const result = await handleMaxAttemptsReached(ctx);

    expect(result.outcome).toBe("failed");
    const failedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(failedStory?.status).toBe("failed");
  });

  test("appends a failed progress entry when featureDir is set", async () => {
    const prdPath = join(tempDir, "prd.json");
    const featureDir = join(tempDir, "feature");
    const ctx = makeCtx({ featureDir }, prdPath);

    await handleMaxAttemptsReached(ctx);

    const progress = await readFile(join(featureDir, "progress.txt"), "utf8");
    expect(progress).toContain("FAILED");
    expect(progress).toContain("Max attempts reached");
  });

  test("emits a story:failed event carrying the per-story cost from the aggregator", async () => {
    const seen: { cost?: number }[] = [];
    const unsubscribe = pipelineEventBus.on("story:failed", (event) => {
      seen.push({ cost: (event as { cost?: number }).cost });
    });
    try {
      const runtime = makeMockRuntime();
      runtime.costAggregator.record({
        ts: Date.now(),
        runId: "test-run",
        agentName: "claude",
        model: "test-model",
        storyId: "US-001",
        tokens: { input: 5, output: 5 },
        estimatedCostUsd: 1.25,
        exactCostUsd: 1.25,
        costUsd: 1.25,
        confidence: "estimated",
        durationMs: 100,
      });
      const prdPath = join(tempDir, "prd.json");
      const ctx = makeCtx({ runtime, totalCost: 9.99 }, prdPath);

      await handleMaxAttemptsReached(ctx);

      expect(seen).toHaveLength(1);
      expect(seen[0].cost).toBe(1.25);
    } finally {
      unsubscribe();
    }
  });

  // AC-4: the handler records no category of its own.
  test("AC-4: the initially uncategorized story has no failureCategory property", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({}, prdPath);

    const result = await handleMaxAttemptsReached(ctx);

    const failedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(Object.hasOwn(failedStory ?? {}, "failureCategory")).toBe(false);
  });

  // AC-5: exactly one terminal event, and it is the failure.
  test("AC-5: emits exactly one story:failed event with reason 'Max attempts reached'", async () => {
    const seen: Array<{ reason?: string }> = [];
    const unsubscribe = pipelineEventBus.on("story:failed", (event) => {
      seen.push({ reason: event.reason });
    });
    try {
      const prdPath = join(tempDir, "prd.json");
      const ctx = makeCtx({}, prdPath);

      await handleMaxAttemptsReached(ctx);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.reason).toBe("Max attempts reached");
    } finally {
      unsubscribe();
    }
  });

  // AC-6: the pause branch is unreachable.
  test("AC-6: emits no story:paused event", async () => {
    const seen: unknown[] = [];
    const unsubscribe = pipelineEventBus.on("story:paused", (event) => {
      seen.push(event);
    });
    try {
      const prdPath = join(tempDir, "prd.json");
      const ctx = makeCtx({}, prdPath);

      await handleMaxAttemptsReached(ctx);

      expect(seen).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});
