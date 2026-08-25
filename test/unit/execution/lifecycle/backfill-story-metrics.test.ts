import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory } from "@test/helpers";
import { synthesizeBackfillMetric } from "@/execution";
import type { StoryRouting } from "@/prd/types";

const TS = "2026-07-03T00:00:00.000Z";
// Default config.models = { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } }
const config = makeNaxConfig();

const routing = (over: Partial<StoryRouting>): StoryRouting => ({
  modelTier: "balanced",
  agent: "claude",
  complexity: "complex",
  testStrategy: "three-session-tdd-lite",
  reasoning: "test fixture",
  ...over,
});

describe("synthesizeBackfillMetric (#1296)", () => {
  test("failed-in-execution story → real attempts/model/tier, source execution-failed", () => {
    // Mirrors a downstream US-001: failed in execution, agent claude @ balanced, 2 attempts.
    const story = makeStory({ id: "US-001", status: "failed", attempts: 2, routing: routing({}) });
    const m = synthesizeBackfillMetric({
      storyId: "US-001",
      story,
      totalCostUsd: 2.15,
      config,
      defaultAgent: "opencode",
      timestamp: TS,
    });
    expect(m.source).toBe("execution-failed");
    expect(m.attempts).toBe(2); // NOT the corrupt 0
    expect(m.modelUsed).toBe("sonnet"); // resolved model id, NOT the "opencode" agent name
    expect(m.agentUsed).toBe("claude");
    expect(m.modelTier).toBe("balanced");
    expect(m.finalTier).toBe("balanced");
    expect(m.success).toBe(false);
    expect(m.cost).toBe(2.15);
    expect(m.complexity).toBe("complex");
  });

  test("regression-failed story is also treated as an execution failure", () => {
    const story = makeStory({
      id: "US-2",
      status: "regression-failed",
      attempts: 1,
      routing: routing({ complexity: "medium" }),
    });
    const m = synthesizeBackfillMetric({
      storyId: "US-2",
      story,
      totalCostUsd: 1,
      config,
      defaultAgent: "opencode",
      timestamp: TS,
    });
    expect(m.source).toBe("execution-failed");
    expect(m.attempts).toBe(1);
    expect(m.success).toBe(false);
  });

  test("escalated failed story → finalTier from last escalation", () => {
    const story = makeStory({
      id: "US-3",
      status: "failed",
      attempts: 1,
      routing: routing({ modelTier: "fast" }),
      escalations: [
        { fromTier: "fast", toTier: "balanced", reason: "r", timestamp: TS },
        { fromTier: "balanced", toTier: "powerful", reason: "r", timestamp: TS },
      ],
    });
    const m = synthesizeBackfillMetric({
      storyId: "US-3",
      story,
      totalCostUsd: 1,
      config,
      defaultAgent: "opencode",
      timestamp: TS,
    });
    expect(m.finalTier).toBe("powerful");
    expect(m.modelTier).toBe("fast");
  });

  test("attempts counts prior cross-tier failures + current-tier attempts", () => {
    const story = makeStory({
      id: "US-4",
      status: "failed",
      attempts: 1,
      priorFailures: [
        { attempt: 1, modelTier: "fast", stage: "verify", summary: "a", timestamp: TS },
        { attempt: 2, modelTier: "balanced", stage: "verify", summary: "b", timestamp: TS },
      ],
      routing: routing({ complexity: "medium" }),
    });
    const m = synthesizeBackfillMetric({
      storyId: "US-4",
      story,
      totalCostUsd: 1,
      config,
      defaultAgent: "opencode",
      timestamp: TS,
    });
    expect(m.attempts).toBe(3); // 2 priorFailures + max(1, attempts=1)
  });

  test("model resolution falls back to the agent name when the tier is not configured", () => {
    // agent "mystery" has no models entry and neither does the default agent "ghost".
    const story = makeStory({ id: "US-5", status: "failed", attempts: 1, routing: routing({ agent: "mystery" }) });
    const m = synthesizeBackfillMetric({
      storyId: "US-5",
      story,
      totalCostUsd: 1,
      config,
      defaultAgent: "ghost",
      timestamp: TS,
    });
    expect(m.agentUsed).toBe("mystery");
    expect(m.modelUsed).toBe("mystery"); // graceful fallback, no throw
  });

  test("completion-phase-only spend (passed story) keeps the placeholder shape", () => {
    const story = makeStory({
      id: "US-6",
      status: "passed",
      attempts: 1,
      passes: true,
      routing: routing({ complexity: "simple" }),
    });
    const m = synthesizeBackfillMetric({
      storyId: "US-6",
      story,
      totalCostUsd: 0.5,
      config,
      defaultAgent: "opencode",
      timestamp: TS,
    });
    expect(m.source).toBe("completion-phase");
    expect(m.attempts).toBe(0);
    expect(m.modelUsed).toBe("opencode"); // defaultAgent placeholder
    expect(m.success).toBe(true);
  });

  test("missing story → completion-phase placeholder, no crash", () => {
    const m = synthesizeBackfillMetric({
      storyId: "ghost",
      story: undefined,
      totalCostUsd: 0.1,
      config,
      defaultAgent: "opencode",
      timestamp: TS,
    });
    expect(m.source).toBe("completion-phase");
    expect(m.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nax#1709: a story that fails in the execution stage never reaches
// collectStoryMetrics, so its agent-swap hops and crash retries were dropped —
// which made deriveRunFallbackAggregates' exhausted rule
// (`!success && lastHop.category === "availability"`) structurally unreachable,
// since only successful stories ever carried hops.
// ---------------------------------------------------------------------------

const HOP = {
  storyId: "US-001",
  priorAgent: "claude",
  newAgent: "codex",
  hop: 1,
  outcome: "fail-quota",
  category: "availability",
  costUsd: 0.4,
} as const;

describe("synthesizeBackfillMetric — swap hops and crash retries (#1709)", () => {
  const failedStory = () => makeStory({ id: "US-001", status: "failed", attempts: 2, routing: routing({}) });

  test("carries the story's agent-swap hops onto the execution-failed metric", () => {
    const m = synthesizeBackfillMetric({
      storyId: "US-001",
      story: failedStory(),
      totalCostUsd: 2.15,
      config,
      defaultAgent: "claude",
      timestamp: TS,
      fallbackHops: [HOP],
    });

    expect(m.source).toBe("execution-failed");
    expect(m.success).toBe(false);
    expect(m.fallback?.hops).toEqual([HOP]);
  });

  test("carries the crash-retry tally instead of a hardcoded zero", () => {
    const m = synthesizeBackfillMetric({
      storyId: "US-001",
      story: failedStory(),
      totalCostUsd: 1,
      config,
      defaultAgent: "claude",
      timestamp: TS,
      runtimeCrashes: 3,
    });

    expect(m.runtimeCrashes).toBe(3);
  });

  test("omits fallback entirely when the story had no swaps", () => {
    const m = synthesizeBackfillMetric({
      storyId: "US-001",
      story: failedStory(),
      totalCostUsd: 1,
      config,
      defaultAgent: "claude",
      timestamp: TS,
      fallbackHops: [],
    });

    expect(m.fallback).toBeUndefined();
    expect(m.runtimeCrashes).toBe(0);
  });

  test("completion-phase-only spend carries neither — nothing executed", () => {
    const m = synthesizeBackfillMetric({
      storyId: "US-009",
      story: makeStory({ id: "US-009", status: "passed", attempts: 0 }),
      totalCostUsd: 0.5,
      config,
      defaultAgent: "claude",
      timestamp: TS,
      fallbackHops: [HOP],
      runtimeCrashes: 2,
    });

    expect(m.source).toBe("completion-phase");
    expect(m.fallback).toBeUndefined();
    expect(m.runtimeCrashes).toBe(0);
  });
});
