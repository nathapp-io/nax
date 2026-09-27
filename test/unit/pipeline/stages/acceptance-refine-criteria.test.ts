/**
 * US-003 (acceptance-refine fails loud): per-story refinement loop.
 *
 * `refineAcceptanceCriteria` refines every story's criteria through the
 * injected `callOp`, keeps the configured concurrency cap and the input story
 * order, and — when a story's refinement rejects after its retries — falls
 * back to that story's unrefined criteria, flagged `refinementFallback: true`,
 * reporting the fallback story ids so the caller can warn once.
 */

import { describe, expect, test } from "bun:test";
import { makeDispatchContext, makeNaxConfig, makePRD, makeStory, withWarnSpy } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { type RefineCallOp, refineAcceptanceCriteria } from "@/pipeline/stages/acceptance-refine-criteria";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FALLBACK_WARN = "AC refinement unusable after retries — using unrefined criteria";

const STORIES: UserStory[] = [
  makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: alpha"] }),
  makeStory({ id: "US-002", acceptanceCriteria: ["AC-2: beta"] }),
  makeStory({ id: "US-003", acceptanceCriteria: ["AC-3: gamma"] }),
];

function makeCtx(refinementConcurrency?: number): PipelineContext {
  return {
    config: makeNaxConfig({
      acceptance: {
        enabled: true,
        refinement: true,
        redGate: true,
        ...(refinementConcurrency === undefined ? {} : { refinementConcurrency }),
      },
    }),
    prd: makePRD({ userStories: STORIES }),
    story: STORIES[0],
    stories: STORIES,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  };
}

/**
 * callOp stub: rejects for the listed story ids, otherwise refines each
 * criterion to `"<storyId>:<criterion>"`.
 */
function makeCallOp(rejectFor: readonly string[] = []): RefineCallOp {
  return async (_ctx, _packageDir, _op, input) => {
    if (rejectFor.includes(input.storyId)) {
      throw new Error(`acceptance-refine: empty output (${input.storyId})`);
    }
    return input.criteria.map((criterion) => ({
      original: criterion,
      refined: `${input.storyId}:${criterion}`,
      testable: true,
      storyId: input.storyId,
    }));
  };
}

// ---------------------------------------------------------------------------
// AC5: a rejected story falls back to its unrefined criteria
// ---------------------------------------------------------------------------

describe("US-003 AC5: refineAcceptanceCriteria fallback", () => {
  test("US-003 AC5: falls back to US-002's unrefined criteria when its callOp rejects", async () => {
    const result = await refineAcceptanceCriteria(makeCtx(), STORIES, new Map(), makeCallOp(["US-002"]));

    const us002 = result.criteria.filter((c) => c.storyId === "US-002");
    expect(us002).toHaveLength(1);
    expect(us002[0]).toMatchObject({
      original: "AC-2: beta",
      refined: "AC-2: beta",
      testable: true,
      storyId: "US-002",
      refinementFallback: true,
    });
    expect(result.fallbackStoryIds).toEqual(["US-002"]);
  });

  test("US-003 AC5 boundary: every criterion of the rejected story falls back, and other stories still refine", async () => {
    const stories = [
      makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: alpha"] }),
      makeStory({ id: "US-002", acceptanceCriteria: ["AC-2: beta", "AC-3: gamma"] }),
    ];
    const result = await refineAcceptanceCriteria(makeCtx(), stories, new Map(), makeCallOp(["US-002"]));

    const fallback = result.criteria.filter((c) => c.refinementFallback === true);
    expect(fallback.map((c) => c.original)).toEqual(["AC-2: beta", "AC-3: gamma"]);
    expect(fallback.every((c) => c.refined === c.original && c.testable)).toBe(true);

    const refined = result.criteria.filter((c) => c.storyId === "US-001");
    expect(refined).toHaveLength(1);
    expect(refined[0]?.refinementFallback).toBeFalsy();
    expect(refined[0]?.refined).toBe("US-001:AC-1: alpha");
    expect(result.fallbackStoryIds).toEqual(["US-002"]);
  });
});

// ---------------------------------------------------------------------------
// AC6 / AC7: run-level warning
// ---------------------------------------------------------------------------

describe("US-003 AC6: run-level warning on fallback", () => {
  test("US-003 AC6: logs exactly one warn listing the fallback story ids", async () => {
    await withWarnSpy(async (warnSpy) => {
      const result = await refineAcceptanceCriteria(makeCtx(), STORIES, new Map(), makeCallOp(["US-001", "US-003"]));

      const warns = warnSpy.mock.calls.filter((call) => call[1] === FALLBACK_WARN);
      expect(warns).toHaveLength(1);
      expect(warns[0]?.[2]).toMatchObject({ storyIds: ["US-001", "US-003"] });
      expect(result.fallbackStoryIds).toEqual(["US-001", "US-003"]);
    });
  });

  test("US-003 AC6 boundary: two failing stories still produce a single warn, with no per-story warn", async () => {
    await withWarnSpy(async (warnSpy) => {
      await refineAcceptanceCriteria(makeCtx(), STORIES, new Map(), makeCallOp(["US-001", "US-002"]));

      expect(warnSpy.mock.calls.filter((call) => call[1] === FALLBACK_WARN)).toHaveLength(1);
      const perStoryWarns = warnSpy.mock.calls.filter(
        (call) => call[1] === "AC refinement failed after retries — using unrefined criteria",
      );
      expect(perStoryWarns).toHaveLength(0);
    });
  });
});

describe("US-003 AC7: no warning when every story refines", () => {
  test("US-003 AC7: logs no fallback warn and reports no fallback stories", async () => {
    await withWarnSpy(async (warnSpy) => {
      const result = await refineAcceptanceCriteria(makeCtx(), STORIES, new Map(), makeCallOp());

      expect(warnSpy.mock.calls.filter((call) => call[1] === FALLBACK_WARN)).toHaveLength(0);
      expect(result.fallbackStoryIds).toEqual([]);
      expect(result.criteria).toHaveLength(3);
    });
  });
});

// ---------------------------------------------------------------------------
// AC10: story order and concurrency cap
// ---------------------------------------------------------------------------

describe("US-003 AC10: ordered output under a concurrency cap", () => {
  test("US-003 AC10: returns criteria in input story order when refinementConcurrency is 1", async () => {
    const result = await refineAcceptanceCriteria(makeCtx(1), STORIES, new Map(), makeCallOp());

    expect(result.criteria.map((c) => c.storyId)).toEqual(["US-001", "US-002", "US-003"]);
    expect(result.criteria.map((c) => c.refined)).toEqual([
      "US-001:AC-1: alpha",
      "US-002:AC-2: beta",
      "US-003:AC-3: gamma",
    ]);
  });

  test("US-003 AC10 boundary: never exceeds the configured refinementConcurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    const cap = 2;
    const gated: RefineCallOp = async (_ctx, _packageDir, _op, input) => {
      inFlight += 1;
      started += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return input.criteria.map((criterion) => ({
        original: criterion,
        refined: `${input.storyId}:${criterion}`,
        testable: true,
        storyId: input.storyId,
      }));
    };

    const result = await refineAcceptanceCriteria(makeCtx(cap), STORIES, new Map(), gated);

    expect(started).toBe(3);
    expect(result.criteria).toHaveLength(3);
    expect(peak).toBeLessThanOrEqual(cap);
    expect(peak).toBeGreaterThan(1);
  });
});
