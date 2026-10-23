import { describe, expect, test } from "bun:test";
import { makeDoneStory, makeFeatureMachineHarness } from "@test/helpers";
import { newFeatureRecord } from "@/workflow/feature-record";
import { branchReviewStep } from "@/workflow/feature-steps";

/** A record the branch-review step runs on: a seed to review, no minors to triage. */
const reviewed = () => ({
  ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
  step: "branch-review" as const,
});

describe("branchReviewStep", () => {
  // US-009: the branch review lists each story's report, so the story's own run dir survives the step boundary.
  test("passes a story's run dir through to the branch review facts (AC-9)", async () => {
    const h = makeFeatureMachineHarness({}, { stories: [makeDoneStory("US-001", { runDir: "/run" })] });
    await branchReviewStep(h.env, reviewed());
    expect(h.reviewFacts[0]?.stories).toEqual([{ id: "US-001", state: "complete", runDir: "/run" }]);
  });

  test("a story with no run dir carries no runDir key", async () => {
    const h = makeFeatureMachineHarness({}, { stories: [makeDoneStory("US-001")] });
    await branchReviewStep(h.env, reviewed());
    expect(h.reviewFacts[0]?.stories).toEqual([{ id: "US-001", state: "complete" }]);
  });
});
