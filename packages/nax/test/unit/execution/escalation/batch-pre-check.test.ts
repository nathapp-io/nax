/**
 * runBatchPreChecks — BUG-8: stale story-object references after a sibling
 * skip's PRD reload.
 *
 * A sibling escalation reloads `prd` into a fresh generation of story
 * objects, but the pre-reload `batch` array still holds the old ones.
 * `dispatchable` must be re-resolved by id against the reloaded PRD so the
 * dispatched objects share identity with the PRD the single-writer save will
 * serialise — otherwise worker mutations written by reference (storyGitRef,
 * repo-scoped fix records) are silently lost.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import { runBatchPreChecks } from "@/execution/escalation";
import type { PreIterationCheckResult } from "@/execution/escalation/tier-escalation";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD, UserStory } from "@/prd";

const HOOKS: LoadedHooksConfig = { hooks: {} };

function baseOptions(overrides: Partial<Parameters<typeof runBatchPreChecks>[0]> = {}) {
  return {
    batch: [],
    prd: makePRD({ userStories: [] }),
    config: makeNaxConfig(),
    prdPath: "/tmp/prd.json",
    featureDir: undefined,
    hooks: HOOKS,
    feature: "test-feature",
    totalCost: 0,
    workdir: "/tmp/repo",
    preIterationTierCheckFn: async (): Promise<PreIterationCheckResult> => ({
      shouldSkipIteration: false,
      prdDirty: false,
      prd: overrides.prd ?? makePRD({ userStories: [] }),
    }),
    loadPRDFn: async (): Promise<PRD> => makePRD({ userStories: [] }),
    ...overrides,
  };
}

describe("runBatchPreChecks — BUG-8 identity re-resolution", () => {
  test("forwards a complete preview and lazy canonical resolver to the tier check", async () => {
    const story = makeStory({ id: "US-1762-batch", status: "pending" });
    const prd = makePRD({ userStories: [story] });
    const resolvedRouting = {
      complexity: "complex" as const,
      modelTier: "fast" as const,
      testStrategy: "three-session-tdd" as const,
      reasoning: "canonical decision",
    };
    const resolveRoutingFn = mock(async () => resolvedRouting);

    await runBatchPreChecks(
      baseOptions({
        batch: [story],
        prd,
        resolveRoutingFn,
        preIterationTierCheckFn: async (
          _story,
          routing,
          _config,
          _prd,
          _prdPath,
          _featureDir,
          _hooks,
          _feature,
          _totalCost,
          _workdir,
          _runtime,
          resolver,
        ) => {
          expect(routing).toMatchObject({ complexity: "medium", testStrategy: "test-after" });
          expect(await resolver?.(story)).toEqual(resolvedRouting);
          return { shouldSkipIteration: false, prdDirty: false, prd };
        },
      }),
    );

    expect(resolveRoutingFn).toHaveBeenCalledWith(story);
  });

  test("no sibling skip: dispatchable objects are the same references as batch (no reload happened)", async () => {
    const kept = makeStory({ id: "US-001", status: "pending" });
    const prd = makePRD({ userStories: [kept] });

    const result = await runBatchPreChecks(
      baseOptions({
        batch: [kept],
        prd,
        preIterationTierCheckFn: async () => ({ shouldSkipIteration: false, prdDirty: false, prd }),
      }),
    );

    expect(result.dispatchable).toHaveLength(1);
    // No reload occurred, so identity is trivially preserved either way —
    // this pins the no-op case so the fix's `?? s` fallback is exercised.
    expect(result.dispatchable[0]).toBe(kept);
  });

  test("a sibling skip reloads the PRD — dispatchable is re-resolved to the NEW generation's object, not the stale batch object", async () => {
    const kept = makeStory({ id: "US-001", status: "pending" });
    const skipped = makeStory({ id: "US-002", status: "pending" });
    const originalPrd = makePRD({ userStories: [kept, skipped] });

    // The reloaded PRD is a distinct object graph — a fresh generation, as a
    // real loadPRD(prdPath) would produce after preIterationTierCheck's own
    // save. keptInNewGeneration is deliberately NOT the same reference as `kept`.
    const keptInNewGeneration = makeStory({ id: "US-001", status: "pending" });
    const reloadedPrd = makePRD({ userStories: [keptInNewGeneration] });

    const result = await runBatchPreChecks(
      baseOptions({
        batch: [kept, skipped],
        prd: originalPrd,
        preIterationTierCheckFn: async (story) => {
          if (story.id === "US-002") {
            return { shouldSkipIteration: true, prdDirty: false, prd: originalPrd };
          }
          return { shouldSkipIteration: false, prdDirty: false, prd: originalPrd };
        },
        loadPRDFn: async () => reloadedPrd,
      }),
    );

    expect(result.dispatchable.map((s: UserStory) => s.id)).toEqual(["US-001"]);
    // The whole point of BUG-8: dispatchable must be the reloaded generation's
    // object, since that is what the single-writer save will persist mutations
    // against by reference (storyGitRef, repo-scoped fix records).
    expect(result.dispatchable[0]).toBe(keptInNewGeneration);
    expect(result.dispatchable[0]).not.toBe(kept);
    expect(result.prd).toBe(reloadedPrd);
  });

  test("a sibling skip reloads the PRD, but the surviving story is missing from the new generation — falls back to the stale object rather than dropping it", async () => {
    const kept = makeStory({ id: "US-001", status: "pending" });
    const skipped = makeStory({ id: "US-002", status: "pending" });
    const originalPrd = makePRD({ userStories: [kept, skipped] });
    // Reloaded PRD is missing US-001 entirely (defensive edge case).
    const reloadedPrd = makePRD({ userStories: [] });

    const result = await runBatchPreChecks(
      baseOptions({
        batch: [kept, skipped],
        prd: originalPrd,
        preIterationTierCheckFn: async (story) => {
          if (story.id === "US-002") {
            return { shouldSkipIteration: true, prdDirty: false, prd: originalPrd };
          }
          return { shouldSkipIteration: false, prdDirty: false, prd: originalPrd };
        },
        loadPRDFn: async () => reloadedPrd,
      }),
    );

    expect(result.dispatchable).toHaveLength(1);
    expect(result.dispatchable[0]).toBe(kept);
  });
});
