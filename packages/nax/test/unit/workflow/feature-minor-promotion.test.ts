import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeFeatureMachineHarness } from "@test/helpers";
import { formatWorkflowSummary } from "@/log-format/workflow-summary";
import { parseBranchReviewReply } from "@/operations/workflow-replies";
import { buildWorkflowBranchFixPrompt, buildWorkflowBranchReviewPrompt } from "@/prompts";
import { newFeatureRecord } from "@/workflow/feature-record";
import { branchFixStep, branchReviewStep } from "@/workflow/feature-steps";
import { buildWorkflowRunSummary } from "@/workflow/run-summary";
import type { WorkflowResultFile } from "@/workflow/types";

const minors = [
  { id: "M1", storyId: "US-001", text: "a", triage: "leave" as const },
  { id: "M2", storyId: "US-001", text: "b", triage: "leave" as const },
  { id: "M3", storyId: "US-001", text: "c", triage: "leave" as const },
];
const record = () => newFeatureRecord({ now: "t", seed: "seed", minors });
const important = { id: "B1", kind: "quality" as const, severity: "important" as const, issue: "problem" };
const timing = { storiesDurationMs: 0, featureWorkflowDurationMs: 0 };

describe("deferred minor promotion", () => {
  test.each([
    ["promote", "promote"],
    ["drop", "leave"],
  ] as const)("parser maps %s to %s", (decision, expected) => {
    const reply = JSON.stringify({ spec: "pass", quality: "approved", minorTriage: [{ id: "M1", decision }] });
    expect(parseBranchReviewReply(reply, ["M1"])?.minorTriage).toEqual([{ id: "M1", decision: expected }]);
  });

  test("review prompt describes consequences and reply shape", () => {
    const text = buildWorkflowBranchReviewPrompt({
      packagePath: "p",
      range: "s..HEAD",
      stories: [],
      minors: [],
      parked: [],
      cannotVerify: [],
      gateFindings: [],
    });
    expect(text).toContain('"minorTriage": [{"id": "M1", "decision": "promote|fix-now|leave"}]');
    expect(text).toContain('"promote" when it describes wrong behaviour a user or caller can reach');
    expect(text).toContain(
      '"leave" when it is style, comment wording, formatting or duplication that no project rule names',
    );
  });

  test("review assigns a B id to the promoted minor and records all decisions", async () => {
    const review = {
      ...featureMachineFixtures.PASS,
      findings: [important],
      minorTriage: [
        { id: "M1", decision: "promote" as const },
        { id: "M2", decision: "fix-now" as const },
        { id: "M3", decision: "leave" as const },
      ],
    };
    const h = makeFeatureMachineHarness({ review }, { record: record() });
    const result = await branchReviewStep(h.env, h.env.record);
    expect(result.patch.reviewOpen).toHaveLength(2);
    expect(result.patch.reviewOpen?.[1]).toEqual({
      id: "B2",
      kind: "quality",
      severity: "important",
      issue: "US-001: a",
    });
    expect(result.patch.minors?.map((m) => m.triage)).toEqual(["promote", "fix-now", "leave"]);
  });

  // US-009: the direct floor is gone — a `changes` verdict with no blocking finding is mismatch
  // evidence, not a work item, so only a promoted minor opens a B id here.
  test.each([
    ["promote", ["US-001: a"]],
    ["leave", []],
  ] as const)("quality floor with %s", async (decision, expected) => {
    const review = {
      ...featureMachineFixtures.PASS,
      quality: "changes" as const,
      minorTriage: [{ id: "M1", decision }],
    };
    const h = makeFeatureMachineHarness({ review }, { record: record() });
    const result = await branchReviewStep(h.env, h.env.record);
    expect(result.patch.reviewOpen?.map((f) => f.issue)).toEqual([...expected]);
  });

  test.each([
    ["pass", [], ["US-001: a"]],
    ["fail", [], ["spec", "US-001: a"]],
    ["pass", [{ kind: "quality", severity: "important", issue: "real defect" }], ["real defect", "US-001: a"]],
  ] as const)(
    "parsed review preserves real and spec findings with promotion (%s)",
    async (spec, findings, expected) => {
      const reply = JSON.stringify({
        spec,
        quality: "changes",
        findings,
        minorTriage: [{ id: "M1", decision: "promote" }],
      });
      const review = parseBranchReviewReply(reply, ["M1"]);
      expect(review).not.toBeNull();
      if (!review) throw new Error("missing verdict");
      const h = makeFeatureMachineHarness({ review }, { record: record() });
      const result = await branchReviewStep(h.env, h.env.record);
      expect(result.patch.reviewOpen?.map((f) => (f.kind === "spec" ? f.kind : f.issue))).toEqual([...expected]);
      expect(result.patch.reviewOpen?.map((f) => f.id)).toEqual(expected.map((_, i) => `B${i + 1}`));
    },
  );

  test("parsed quality floor stays without promotion, and identical reviewer text stays with promotion", async () => {
    const issue =
      "Story review returned quality: changes without a blocking finding. Re-read the story diff for the quality problem the reviewer saw, and fix it.";
    for (const promoted of [false, true]) {
      const findings = promoted ? [{ kind: "quality", severity: "important", issue }] : [];
      const reply = JSON.stringify({
        spec: "pass",
        quality: "changes",
        findings,
        minorTriage: [{ id: "M1", decision: promoted ? "promote" : "leave" }],
      });
      const review = parseBranchReviewReply(reply, ["M1"]);
      if (!review) throw new Error("missing verdict");
      const h = makeFeatureMachineHarness({ review }, { record: record() });
      const result = await branchReviewStep(h.env, h.env.record);
      expect(result.patch.reviewOpen?.map((f) => f.issue)).toEqual(promoted ? [issue, "US-001: a"] : [issue]);
    }
  });

  test("round one orders review, gates, then fix-now, excluding promoted minors", async () => {
    const rec = {
      ...record(),
      reviewOpen: [{ ...important, id: "B3" }],
      gateFindings: [important, { ...important, id: "B2" }],
      minors: [{ ...minors[0], triage: "fix-now" as const }],
    };
    const h = makeFeatureMachineHarness({}, { record: rec });
    await branchFixStep(h.env, rec);
    expect(h.fixInputs[0]?.map((f) => f.id)).toEqual(["B3", "B1", "B2", "M1"]);
    const promoted = {
      ...rec,
      reviewOpen: [{ ...important, id: "B2" }],
      gateFindings: [],
      minors: [{ ...minors[0], triage: "promote" as const }],
    };
    const h2 = makeFeatureMachineHarness({}, { record: promoted });
    await branchFixStep(h2.env, promoted);
    expect(h2.fixInputs[0]?.map((f) => f.id)).toEqual(["B2"]);
  });

  test("fix prompt partitions and prioritizes findings", () => {
    const make = (findings: readonly (typeof important)[]) =>
      buildWorkflowBranchFixPrompt({ reportPath: "r", findings });
    const text = buildWorkflowBranchFixPrompt({
      reportPath: "r",
      findings: [{ ...important, id: "M1", severity: "minor" }, important],
    });
    expect(text.indexOf("## Findings to fix")).toBeLessThan(text.indexOf("[B1]"));
    expect(text.indexOf("[B1]")).toBeLessThan(text.indexOf("## Minor findings to fix after those"));
    expect(text.indexOf("## Minor findings to fix after those")).toBeLessThan(text.indexOf("[M1]"));
    expect(make([important])).not.toContain("## Minor findings to fix after those");
    expect(text).toContain("Fix the findings in the first list before the minor ones.");
  });

  test("summary counts triage independently of new minors", () => {
    const triages = [
      "promote",
      "promote",
      "fix-now",
      "fix-now",
      "fix-now",
      "leave",
      "leave",
      "leave",
      "leave",
    ] as const;
    const rec = {
      ...record(),
      reviewRan: true,
      minors: triages.map((triage, i) => ({ id: `M${i}`, storyId: "US-001", text: "x", triage })),
      newMinors: ["new"],
    };
    const file: WorkflowResultFile = { schemaVersion: 1, runId: "r", feature: "f", stories: {}, featureWorkflow: rec };
    const view = buildWorkflowRunSummary(file, timing);
    expect(view?.branch?.minors).toEqual({ found: 9, promoted: 2, fixNow: 3, left: 4 });
    expect(view?.branch?.minorsLeft).toBe(5);
    expect(
      buildWorkflowRunSummary(
        { ...file, featureWorkflow: { ...rec, minors: rec.minors.filter((m) => m.triage !== "fix-now") } },
        timing,
      )?.branch?.minorsLeft,
    ).toBe(5);
    expect(
      buildWorkflowRunSummary({ ...file, featureWorkflow: { ...rec, minors: [] } }, timing)?.branch,
    ).not.toHaveProperty("minors");
    if (!view) throw new Error("missing summary");
    expect(formatWorkflowSummary(view, { useColor: false })).toContain(
      "Deferred minors: 9 found, 2 promoted, 3 fix-now, 4 left",
    );
  });
});
