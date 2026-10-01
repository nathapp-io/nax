/**
 * US-003 (acceptance-refine fails loud): the single run-level fallback warn
 * carries each failing story's rejection cause.
 *
 * Without the cause the warn is a bare list of story ids, so telling an empty
 * response apart from unusable JSON, a count mismatch or a transport error
 * requires reproducing the run. The `failures` field carries one entry per
 * fallback story, in story order.
 */

import { describe, expect, test } from "bun:test";
import { makeDispatchContext, makeNaxConfig, makePRD, makeStory, withWarnSpy } from "@test/helpers";
import { ParseValidationError } from "@/agents/retry";
import { DEFAULT_CONFIG } from "@/config";
import { type RefineCallOp, refineAcceptanceCriteria } from "@/pipeline/stages/acceptance-refine-criteria";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";

const FALLBACK_WARN = "AC refinement unusable after retries — using unrefined criteria";

const STORIES: UserStory[] = [
  makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: alpha"] }),
  makeStory({ id: "US-002", acceptanceCriteria: ["AC-2: beta"] }),
  makeStory({ id: "US-003", acceptanceCriteria: ["AC-3: gamma"] }),
];

function makeCtx(): PipelineContext {
  return {
    config: makeNaxConfig({ acceptance: { enabled: true, refinement: true, redGate: true } }),
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

/** Rejects with a per-story error from `failures`; refines every other story. */
function makeCallOp(failures: Readonly<Record<string, Error>>): RefineCallOp {
  return async (_ctx, _packageDir, _op, input) => {
    const failure = failures[input.storyId];
    if (failure) throw failure;
    return input.criteria.map((criterion) => ({
      original: criterion,
      refined: `${input.storyId}:${criterion}`,
      testable: true,
      storyId: input.storyId,
    }));
  };
}

describe("US-003: the fallback warn carries each rejection cause", () => {
  test("US-003: reports the failure reason for every fallback story, in story order", async () => {
    await withWarnSpy(async (warnSpy) => {
      const callOp = makeCallOp({
        "US-001": new Error("acceptance-refine: empty output"),
        "US-003": new ParseValidationError("acceptance-refine: returned 2 of 3 criteria"),
      });

      const result = await refineAcceptanceCriteria(makeCtx(), STORIES, new Map(), callOp);

      const warns = warnSpy.mock.calls.filter((call) => call[1] === FALLBACK_WARN);
      expect(warns).toHaveLength(1);

      // Exactly one entry per fallback story, in story order — US-002 refined
      // normally and so must not appear.
      expect(warns[0]?.[2]).toMatchObject({
        storyId: "US-001",
        storyIds: ["US-001", "US-003"],
        failures: [
          { storyId: "US-001", error: "acceptance-refine: empty output" },
          { storyId: "US-003", error: "acceptance-refine: returned 2 of 3 criteria" },
        ],
      });
      expect(result.fallbackStoryIds).toEqual(["US-001", "US-003"]);
    });
  });

  test("US-003 boundary: a single failure reports a single reason", async () => {
    await withWarnSpy(async (warnSpy) => {
      const callOp = makeCallOp({
        "US-002": new ParseValidationError("acceptance-refine: unusable refinement output"),
      });

      await refineAcceptanceCriteria(makeCtx(), STORIES, new Map(), callOp);

      const warns = warnSpy.mock.calls.filter((call) => call[1] === FALLBACK_WARN);
      expect(warns).toHaveLength(1);
      expect(warns[0]?.[2]).toMatchObject({
        storyId: "US-002",
        storyIds: ["US-002"],
        failures: [{ storyId: "US-002", error: "acceptance-refine: unusable refinement output" }],
      });
    });
  });
});
