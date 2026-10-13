/** Builds the end-of-run workflow summary from result.json (nax#2491 P5): reuses its tokensByRole and timings. */
import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { newStoryRecord } from "@/workflow/result";
import { buildWorkflowRunSummary } from "@/workflow/run-summary";
import type { WorkflowResultFile } from "@/workflow/types";

const tok = (inputTokens: number, outputTokens: number, costUsd: number, calls: number) => ({
  inputTokens,
  outputTokens,
  costUsd,
  calls,
});

function resultFile(): WorkflowResultFile {
  const feature = newFeatureRecord({ now: "t", seed: "s", minors: [] });
  return {
    schemaVersion: 1,
    runId: "r1",
    feature: "f",
    stories: {
      "US-001": {
        ...newStoryRecord("US-001", 5, "t"),
        state: "complete",
        round: 0,
        tokensByRole: { implementer: tok(100, 10, 1, 2), "story-review": tok(50, 5, 0.5, 1) },
      },
      "US-002": {
        ...newStoryRecord("US-002", 5, "t"),
        state: "complete-with-rulings",
        round: 3,
        tokensByRole: { implementer: tok(300, 30, 3, 6) },
      },
    },
    featureWorkflow: {
      ...feature,
      step: "done",
      nextFindingId: 5,
      reviewOpen: [{ id: "B4", kind: "quality", severity: "important", issue: "x" }],
      newMinors: ["nit"],
      finalGates: { ran: ["lint"], failing: [] },
      outcome: "local-only",
      reasons: ["no forge"],
      tokensByRole: { "branch-review": tok(40, 4, 0.59, 1) },
    },
  };
}

describe("buildWorkflowRunSummary", () => {
  const view = buildWorkflowRunSummary(resultFile(), { storiesDurationMs: 100, featureWorkflowDurationMs: 40 });

  test("carries the two durations", () => {
    expect(view).toMatchObject({ storiesDurationMs: 100, featureWorkflowDurationMs: 40 });
  });

  test("sums tokens and cost by role across the stories and the feature workflow", () => {
    expect(view?.roles).toEqual([
      { role: "branch-review", inputTokens: 40, outputTokens: 4, costUsd: 0.59, calls: 1 },
      { role: "implementer", inputTokens: 400, outputTokens: 40, costUsd: 4, calls: 8 },
      { role: "story-review", inputTokens: 50, outputTokens: 5, costUsd: 0.5, calls: 1 },
    ]);
  });

  test("rounds per story", () => {
    expect(view?.stories).toEqual([
      { id: "US-001", rounds: 0, maxRounds: 5, state: "complete" },
      { id: "US-002", rounds: 3, maxRounds: 5, state: "complete-with-rulings" },
    ]);
  });

  test("branch findings: found is every B id issued, left is still open, fixed is the rest", () => {
    expect(view?.branch).toEqual({ found: 4, fixed: 3, left: 1, minorsLeft: 1 });
  });

  test("publish outcome and final gates", () => {
    expect(view?.publish).toEqual({ outcome: "local-only", reasons: ["no forge"] });
    expect(view?.finalGates).toBe("green");
  });

  test("no feature workflow record: the branch and publish sections are absent", () => {
    const { featureWorkflow: _drop, ...noFeature } = resultFile();
    const v = buildWorkflowRunSummary(noFeature, { storiesDurationMs: 1, featureWorkflowDurationMs: 0 });
    expect(v?.branch).toBeUndefined();
    expect(v?.publish).toBeUndefined();
  });

  test("a missing result file yields no summary", () => {
    expect(buildWorkflowRunSummary(null, { storiesDurationMs: 1, featureWorkflowDurationMs: 1 })).toBeNull();
  });
});
