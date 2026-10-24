/** Builds the end-of-run workflow summary from result.json (nax#2491 P5): reuses its tokensByRole and timings. */
import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { newStoryRecord } from "@/workflow/result";
import { buildWorkflowRunSummary } from "@/workflow/run-summary";
import type { RoleTokens, WorkflowFeatureRecord, WorkflowResultFile } from "@/workflow/types";

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
      reviewRan: true,
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

  // nax#2547 / nax#2548: how many fix and gate-repair rounds the feature workflow spent.
  test("the record's fix and gate-repair rounds reach the view; absent when none ran", () => {
    const file = resultFile();
    const rec = file.featureWorkflow;
    if (!rec) throw new Error("fixture has a feature record");
    const v = buildWorkflowRunSummary(
      { ...file, featureWorkflow: { ...rec, fixRounds: 2, gateRepairRounds: 1 } },
      { storiesDurationMs: 0, featureWorkflowDurationMs: 0 },
    );
    expect(v?.branch?.fixRounds).toBe(2);
    expect(v?.gateRepairRounds).toBe(1);
    expect(view).not.toHaveProperty("gateRepairRounds");
  });

  // US-008: the CI repair rounds the feature workflow spent on a failed CI.
  test("AC-12: the record's CI repair rounds reach the view", () => {
    const file = resultFile();
    const rec = file.featureWorkflow;
    if (!rec) throw new Error("fixture has a feature record");
    const v = buildWorkflowRunSummary(
      { ...file, featureWorkflow: { ...rec, ciRepairRounds: 2 } },
      { storiesDurationMs: 0, featureWorkflowDurationMs: 0 },
    );
    expect(v?.ciRepairRounds).toBe(2);
  });

  test("AC-13: no CI repair rounds, no ciRepairRounds field", () => {
    expect(view).not.toHaveProperty("ciRepairRounds");
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

  describe("flagged rulings (US-005)", () => {
    const withFeature = (over: Partial<NonNullable<WorkflowResultFile["featureWorkflow"]>>): WorkflowResultFile => {
      const file = resultFile();
      const rec = file.featureWorkflow;
      if (!rec) throw new Error("fixture has a feature record");
      return { ...file, featureWorkflow: { ...rec, ...over } };
    };
    const timing = { storiesDurationMs: 100, featureWorkflowDurationMs: 40 };

    test("a local-only record carries the ids and the feature hint", () => {
      const v = buildWorkflowRunSummary(withFeature({ outcome: "local-only", flaggedDecisions: ["D-1"] }), timing, "f");
      expect(v?.flagged).toEqual({ ids: ["D-1"], hint: "nax advisor list -f f" });
    });

    test("a ready record shows them just the same", () => {
      const v = buildWorkflowRunSummary(withFeature({ outcome: "ready", flaggedDecisions: ["D-2"] }), timing, "f");
      expect(v?.flagged).toEqual({ ids: ["D-2"], hint: "nax advisor list -f f" });
    });

    test("no feature argument: the bare hint", () => {
      const v = buildWorkflowRunSummary(withFeature({ flaggedDecisions: ["D-1"] }), timing);
      expect(v?.flagged?.hint).toBe("nax advisor list");
      expect(v?.flagged?.ids).toEqual(["D-1"]);
    });

    test("no flaggedDecisions: no flagged key", () => {
      expect(buildWorkflowRunSummary(withFeature({ flaggedDecisions: undefined }), timing, "f")).not.toHaveProperty(
        "flagged",
      );
    });

    test("an empty list: no flagged key", () => {
      expect(buildWorkflowRunSummary(withFeature({ flaggedDecisions: [] }), timing, "f")).not.toHaveProperty("flagged");
    });
  });

  describe("CI repair concerns (US-005)", () => {
    const timing = { storiesDurationMs: 100, featureWorkflowDurationMs: 40 };

    /** The fixture's record with the CI repair concerns the run's replies raised. */
    function withConcerns(concerns: readonly string[] | undefined): WorkflowResultFile {
      const file = resultFile();
      const rec = file.featureWorkflow;
      if (!rec) throw new Error("fixture has a feature record");
      return { ...file, featureWorkflow: { ...rec, ciRepairConcerns: concerns } };
    }

    test("AC-13: the record's CI repair concerns reach the view", () => {
      expect(buildWorkflowRunSummary(withConcerns(["r1: a"]), timing)?.ciRepairConcerns).toEqual(["r1: a"]);
    });

    test("AC-14: no CI repair concerns, no ciRepairConcerns field", () => {
      // The control: the same fixture with a concern does carry the field.
      expect(buildWorkflowRunSummary(withConcerns(["r1: a"]), timing)).toHaveProperty("ciRepairConcerns");
      expect(buildWorkflowRunSummary(withConcerns(undefined), timing)).not.toHaveProperty("ciRepairConcerns");
      expect(buildWorkflowRunSummary(withConcerns([]), timing)).not.toHaveProperty("ciRepairConcerns");
    });
  });

  // US-006: what the last repair round left red, named so a human knows where to look.
  describe("the checks still failing after the last repair round (US-006)", () => {
    const timing = { storiesDurationMs: 100, featureWorkflowDurationMs: 40 };

    /** The fixture's record with the checks still red after the last repair round. */
    function withRemaining(remaining: WorkflowFeatureRecord["ciRemaining"]): WorkflowResultFile {
      const file = resultFile();
      const rec = file.featureWorkflow;
      if (!rec) throw new Error("fixture has a feature record");
      return { ...file, featureWorkflow: { ...rec, ciRemaining: remaining } };
    }

    test("AC-17: each remaining check names the step it failed at, when the CI named one", () => {
      const v = buildWorkflowRunSummary(
        withRemaining([
          { name: "Security audit", failedStep: "pip-audit", newFailure: true },
          { name: "e2e", newFailure: false },
        ]),
        timing,
      );
      expect(v?.ciRemaining).toEqual(['Security audit at step "pip-audit"', "e2e"]);
    });

    test("no checks left red: no ciRemaining key", () => {
      // The control: the same fixture with a remaining check does carry the field.
      expect(buildWorkflowRunSummary(withRemaining([{ name: "e2e", newFailure: true }]), timing)).toHaveProperty(
        "ciRemaining",
      );
      expect(buildWorkflowRunSummary(withRemaining(undefined), timing)).not.toHaveProperty("ciRemaining");
      expect(buildWorkflowRunSummary(withRemaining([]), timing)).not.toHaveProperty("ciRemaining");
    });
  });

  describe("branch review skipped (L3)", () => {
    test("no branch section, and the view says the review was skipped", () => {
      const file = resultFile();
      const rec = file.featureWorkflow;
      if (!rec) throw new Error("fixture has a feature record");
      const v = buildWorkflowRunSummary(
        { ...file, featureWorkflow: { ...rec, reviewRan: false } },
        { storiesDurationMs: 1, featureWorkflowDurationMs: 1 },
      );
      expect(v?.branch).toBeUndefined();
      expect(v?.branchReviewSkipped).toEqual({ minorsLeft: 1 });
    });

    test("a review that ran has a branch section and no skipped flag", () => {
      const file = resultFile();
      const rec = file.featureWorkflow;
      if (!rec) throw new Error("fixture has a feature record");
      const v = buildWorkflowRunSummary(
        { ...file, featureWorkflow: { ...rec, reviewRan: true } },
        { storiesDurationMs: 1, featureWorkflowDurationMs: 1 },
      );
      expect(v?.branch).toBeDefined();
      expect(v?.branchReviewSkipped).toBeUndefined();
    });
  });

  describe("the pre-flight's own role totals (US-004)", () => {
    const timing = { storiesDurationMs: 100, featureWorkflowDurationMs: 40 };
    /** One story at advisor $0.1, a feature record at advisor $0.2, a pre-flight at advisor $0.3. */
    function preflightResult(): WorkflowResultFile {
      const file = resultFile();
      const rec = file.featureWorkflow;
      if (!rec) throw new Error("fixture has a feature record");
      return {
        schemaVersion: 1,
        runId: file.runId,
        feature: file.feature,
        stories: { "US-001": { ...newStoryRecord("US-001", 5, "t"), tokensByRole: { advisor: tok(1, 1, 0.1, 1) } } },
        featureWorkflow: { ...rec, tokensByRole: { advisor: tok(1, 1, 0.2, 1) } },
        preflightTokensByRole: { advisor: tok(10, 5, 0.3, 1) },
      };
    }

    test("AC-6: the pre-flight's advisor spend folds into the one advisor role row", () => {
      const v = buildWorkflowRunSummary(preflightResult(), timing);
      expect(v?.roles).toHaveLength(1);
      expect(v?.roles[0]?.role).toBe("advisor");
      expect(v?.roles[0]?.costUsd).toBeCloseTo(0.6, 10);
      expect(v?.roles[0]?.inputTokens).toBe(12);
      expect(v?.roles[0]?.outputTokens).toBe(7);
      expect(v?.roles[0]?.calls).toBe(3);
    });

    test("AC-7: a result without preflightTokensByRole reports exactly the roles it did before", () => {
      const { preflightTokensByRole: _drop, ...withoutPreflight } = preflightResult();
      const v = buildWorkflowRunSummary(withoutPreflight, timing);
      expect(v?.roles).toEqual([{ role: "advisor", inputTokens: 2, outputTokens: 2, costUsd: 0.1 + 0.2, calls: 2 }]);
    });
  });

  // US-005 (nax#2525): cache tokens ride along with the role table, and a legacy record reads as zero.
  describe("cache tokens", () => {
    const timing = { storiesDurationMs: 100, featureWorkflowDurationMs: 40 };

    function advisorResult(tokens: Readonly<Record<string, RoleTokens>>): WorkflowResultFile {
      const file = resultFile();
      const rec = file.featureWorkflow;
      if (!rec) throw new Error("fixture has a feature record");
      return {
        schemaVersion: 1,
        runId: file.runId,
        feature: file.feature,
        stories: {},
        featureWorkflow: { ...rec, tokensByRole: tokens },
      };
    }

    test("AC-5: a feature's cache reads reach the advisor role entry", () => {
      const v = buildWorkflowRunSummary(
        advisorResult({ advisor: { ...tok(4, 10, 0.1, 1), cacheReadTokens: 100 } }),
        timing,
      );
      expect(v?.roles).toEqual([
        { role: "advisor", inputTokens: 4, outputTokens: 10, costUsd: 0.1, calls: 1, cacheReadTokens: 100 },
      ]);
    });

    test("AC-24: a legacy advisor entry with no cache fields reports neither cache key", () => {
      const v = buildWorkflowRunSummary(advisorResult({ advisor: tok(4, 10, 0.1, 1) }), timing);
      expect(v?.roles).toEqual([{ role: "advisor", inputTokens: 4, outputTokens: 10, costUsd: 0.1, calls: 1 }]);
      expect(v?.roles[0] ?? {}).not.toHaveProperty("cacheReadTokens");
      expect(v?.roles[0] ?? {}).not.toHaveProperty("cacheWriteTokens");
    });
  });
});
