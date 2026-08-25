// test/unit/metrics/fallback-aggregates.test.ts
//
// PR-2 (ADR-012 review): Cover `deriveRunFallbackAggregates` and AgentFallbackHop.costUsd.
// The helper is a pure function over StoryMetrics[] → RunFallbackAggregate | undefined.

import { describe, expect, test } from "bun:test";
import { makeNaxConfig, makeStory } from "@test/helpers";
import { synthesizeBackfillMetric } from "@/execution";
import { deriveRunFallbackAggregates } from "@/metrics/aggregator";
import type { AgentFallbackHop, RunFallbackAggregate, RunMetrics, StoryMetrics } from "@/metrics/types";

function storyWithHops(storyId: string, hops: AgentFallbackHop[], extra: Partial<StoryMetrics> = {}): StoryMetrics {
  return {
    storyId,
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-sonnet",
    attempts: 1,
    finalTier: "balanced",
    success: true,
    cost: 0,
    durationMs: 0,
    firstPassSuccess: true,
    startedAt: "2026-04-20T00:00:00.000Z",
    completedAt: "2026-04-20T00:00:01.000Z",
    ...extra,
    ...(hops.length > 0 && { fallback: { hops } }),
  };
}

function hop(
  storyId: string,
  priorAgent: string,
  newAgent: string,
  costUsd: number,
  overrides: Partial<AgentFallbackHop> = {},
): AgentFallbackHop {
  return {
    storyId,
    priorAgent,
    newAgent,
    outcome: "fail-auth",
    category: "availability",
    hop: 1,
    costUsd,
    ...overrides,
  };
}

describe("AgentFallbackHop.costUsd (PR-2 type change)", () => {
  test("hop literal accepts costUsd field", () => {
    const h: AgentFallbackHop = {
      storyId: "US-001",
      priorAgent: "codex",
      newAgent: "claude",
      outcome: "fail-auth",
      category: "availability",
      hop: 1,
      costUsd: 0.42,
    };
    expect(h.costUsd).toBe(0.42);
  });
});

describe("RunFallbackAggregate shape (PR-2 type change)", () => {
  test("exposes totalHops, perPair, exhaustedStories, totalWastedCostUsd", () => {
    const agg: RunFallbackAggregate = {
      totalHops: 3,
      perPair: { "codex->claude": 2, "claude->opencode": 1 },
      exhaustedStories: ["US-007"],
      totalWastedCostUsd: 0.17,
    };
    expect(agg.totalHops).toBe(3);
    expect(agg.perPair["codex->claude"]).toBe(2);
    expect(agg.exhaustedStories).toEqual(["US-007"]);
    expect(agg.totalWastedCostUsd).toBeCloseTo(0.17, 5);
  });

  test("RunMetrics accepts optional fallback field", () => {
    const run: RunMetrics = {
      runId: "r1",
      feature: "f1",
      startedAt: "2026-04-20T00:00:00.000Z",
      completedAt: "2026-04-20T00:00:10.000Z",
      totalCost: 0,
      totalStories: 1,
      storiesCompleted: 1,
      storiesFailed: 0,
      totalDurationMs: 10_000,
      stories: [],
      fallback: { totalHops: 0, perPair: {}, exhaustedStories: [], totalWastedCostUsd: 0 },
    };
    expect(run.fallback?.totalHops).toBe(0);
  });
});

describe("deriveRunFallbackAggregates", () => {
  test("returns undefined when no stories have fallback hops", () => {
    const s = storyWithHops("US-001", []);
    expect(deriveRunFallbackAggregates([s])).toBeUndefined();
  });

  test("returns undefined for empty story list", () => {
    expect(deriveRunFallbackAggregates([])).toBeUndefined();
  });

  test("totals hops across all stories", () => {
    const s1 = storyWithHops("US-001", [hop("US-001", "codex", "claude", 0.05)]);
    const s2 = storyWithHops("US-002", [
      hop("US-002", "codex", "claude", 0.03),
      hop("US-002", "claude", "opencode", 0.02, { hop: 2 }),
    ]);
    const agg = deriveRunFallbackAggregates([s1, s2]);
    expect(agg).toBeDefined();
    expect(agg?.totalHops).toBe(3);
  });

  test("groups hops by priorAgent->newAgent pair", () => {
    const s1 = storyWithHops("US-001", [hop("US-001", "codex", "claude", 0.01)]);
    const s2 = storyWithHops("US-002", [hop("US-002", "codex", "claude", 0.01)]);
    const s3 = storyWithHops("US-003", [hop("US-003", "claude", "opencode", 0.01)]);
    const agg = deriveRunFallbackAggregates([s1, s2, s3]);
    expect(agg?.perPair).toEqual({
      "codex->claude": 2,
      "claude->opencode": 1,
    });
  });

  test("sums costUsd across all hops into totalWastedCostUsd", () => {
    const s1 = storyWithHops("US-001", [hop("US-001", "codex", "claude", 0.07)]);
    const s2 = storyWithHops("US-002", [
      hop("US-002", "codex", "claude", 0.03),
      hop("US-002", "claude", "opencode", 0.11, { hop: 2 }),
    ]);
    const agg = deriveRunFallbackAggregates([s1, s2]);
    expect(agg?.totalWastedCostUsd).toBeCloseTo(0.21, 5);
  });

  // nax#1707: this previously built a hop with costUsd deleted, to "simulate
  // deserialized-from-disk records". No such path exists — deriveRunFallbackAggregates
  // is only ever called (run-completion.ts) with the in-memory allStoryMetrics of the
  // run in flight, and collectStoryMetrics fills costUsd from AgentFallbackRecord,
  // where it is required. The reachable zero-cost case is an adapter that reported no
  // cost, which AgentManager records as costUsd: 0 — that is what is pinned here.
  test("a hop whose adapter reported no cost contributes 0 to the wasted total", () => {
    const s = storyWithHops("US-001", [hop("US-001", "codex", "claude", 0)]);
    const agg = deriveRunFallbackAggregates([s]);
    expect(agg?.totalHops).toBe(1);
    expect(agg?.totalWastedCostUsd).toBe(0);
  });

  test("reports exhausted stories — last hop is availability failure AND story.success=false", () => {
    const s1 = storyWithHops(
      "US-001",
      [
        hop("US-001", "codex", "claude", 0.01, { outcome: "fail-auth", category: "availability" }),
        hop("US-001", "claude", "opencode", 0.01, {
          hop: 2,
          outcome: "fail-rate-limit",
          category: "availability",
        }),
      ],
      { success: false },
    );
    const s2 = storyWithHops(
      "US-002",
      [hop("US-002", "codex", "claude", 0.01, { outcome: "fail-auth", category: "availability" })],
      { success: true },
    );
    const agg = deriveRunFallbackAggregates([s1, s2]);
    expect(agg?.exhaustedStories).toEqual(["US-001"]);
  });

  test("does not mark a story as exhausted when a swap eventually succeeded", () => {
    const s = storyWithHops(
      "US-001",
      [hop("US-001", "codex", "claude", 0.01, { outcome: "fail-auth", category: "availability" })],
      { success: true },
    );
    const agg = deriveRunFallbackAggregates([s]);
    expect(agg?.exhaustedStories).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// nax#1709: exhaustedStories requires `!story.success`, and before this fix only
// SUCCESSFUL stories ever carried hops — collectStoryMetrics runs on the success
// path only. The rule was therefore structurally unreachable. This pins that a
// failed story synthesised by the back-fill now satisfies it.
// ---------------------------------------------------------------------------

describe("deriveRunFallbackAggregates — exhausted rule is reachable (#1709)", () => {
  test("reports a failed story whose last hop was an availability failure", () => {
    const failed = synthesizeBackfillMetric({
      storyId: "US-001",
      story: makeStory({ id: "US-001", status: "failed", attempts: 2 }),
      totalCostUsd: 2,
      config: makeNaxConfig(),
      defaultAgent: "claude",
      timestamp: "2026-08-25T00:00:00.000Z",
      fallbackHops: [
        hop("US-001", "claude", "codex", 0.4),
        hop("US-001", "codex", "opencode", 0.6, { hop: 2, outcome: "fail-service-down" }),
      ],
    });

    const agg = deriveRunFallbackAggregates([failed]);

    expect(failed.success).toBe(false);
    expect(agg?.totalHops).toBe(2);
    expect(agg?.totalWastedCostUsd).toBeCloseTo(1.0, 5);
    expect(agg?.exhaustedStories).toEqual(["US-001"]);
  });
});
