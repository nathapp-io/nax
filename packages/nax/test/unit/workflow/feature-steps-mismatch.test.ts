/**
 * US-009: the branch-review step stops synthesizing verdict-floor work and records the mismatch the
 * verdict itself carries. A mismatch is evidence, never a finding: it spends no B id, opens no fix
 * round and reaches the record as `reviewMismatch`.
 */
import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeFeatureMachineHarness } from "@test/helpers";
import { parseBranchReviewReply } from "@/operations/workflow-replies";
import { newFeatureRecord } from "@/workflow/feature-record";
import { branchReReviewStep, branchReviewStep, withQualityFloor } from "@/workflow/feature-steps";
import type { BranchReviewVerdict, WorkflowFeatureRecord } from "@/workflow/types";

const { PASS } = featureMachineFixtures;

const minors = [{ id: "M1", storyId: "US-001", text: "rename tmp", triage: "leave" as const }];
const record = (over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "seed0", minors }),
  ...over,
});

/** One verdict whose findings are `findings`, everything else clean. */
const verdictOf = (over: Partial<BranchReviewVerdict> = {}): BranchReviewVerdict => ({ ...PASS, ...over });

const IMPORTANT = { kind: "quality" as const, severity: "important" as const, issue: "real defect" };
const MINOR = { kind: "quality" as const, severity: "minor" as const, issue: "naming nit" };

describe("withQualityFloor (US-009)", () => {
  test("adds no draft of its own: the blocking drafts plus the promoted minors (AC-2)", () => {
    const promoted = [{ kind: "quality" as const, severity: "important" as const, issue: "US-001: rename tmp" }];
    const verdict = verdictOf({ quality: "changes", findings: [MINOR] });
    // Nothing blocking in the verdict and no promoted minor: there is nothing to fix, so nothing is invented.
    expect(withQualityFloor(verdict, [])).toEqual([]);
    // The two sources of a B id are the verdict's own blocking drafts and the promoted minors.
    expect(withQualityFloor(verdict, promoted)).toEqual(promoted);
    expect(withQualityFloor(verdictOf({ quality: "changes", findings: [IMPORTANT, MINOR] }), promoted)).toEqual([
      IMPORTANT,
      ...promoted,
    ]);
  });

  test("still excludes the parser-marked quality floor when a minor is promoted (AC-3)", () => {
    const parsed = parseBranchReviewReply(JSON.stringify({ spec: "pass", quality: "changes" }), ["M1"]);
    if (!parsed) throw new Error("the parsed verdict must exist");
    const promoted = [{ kind: "quality" as const, severity: "important" as const, issue: "US-001: rename tmp" }];
    // With a promoted minor the parser's own floor is not reviewer evidence, so it is not blocking.
    expect(withQualityFloor(parsed, promoted)).toEqual(promoted);
    // Without one the floor stays, exactly as before US-009.
    expect(withQualityFloor(parsed, [])).toEqual([...parsed.findings]);
  });

  test("a changes verdict with no blocking finding and no promoted minor adds nothing (AC-4)", () => {
    expect(withQualityFloor(verdictOf({ quality: "changes", findings: [] }), [])).toEqual([]);
    expect(withQualityFloor(verdictOf({ quality: "changes", findings: [MINOR] }), [])).toEqual([]);
  });
});

describe("branchReviewStep findings (US-009)", () => {
  test("writes the artifact with assigned ids and no synthesized floor draft (AC-1)", async () => {
    const h = makeFeatureMachineHarness({ review: verdictOf({ findings: [IMPORTANT, MINOR] }) }, { record: record() });
    const result = await branchReviewStep(h.env, h.env.record);
    // The blocking finding carries the id the file and result.json both name; the minor stays a minor.
    expect(h.artifacts["branch-review.json"]).toMatchObject({ findings: [{ ...IMPORTANT, id: "B1" }, MINOR] });
    expect(result.patch.reviewOpen).toEqual([{ ...IMPORTANT, id: "B1" }]);
    expect(result.patch.nextFindingId).toBe(2);
  });

  test("a changes verdict with no finding opens no B id (AC-1, AC-4)", async () => {
    const h = makeFeatureMachineHarness(
      { review: verdictOf({ quality: "changes", findings: [] }) },
      { record: record() },
    );
    const result = await branchReviewStep(h.env, h.env.record);
    expect(h.artifacts["branch-review.json"]).toMatchObject({ findings: [] });
    expect(result.patch.reviewOpen).toEqual([]);
    expect(result.patch.nextFindingId).toBe(1);
  });
});

describe("branchReviewStep reviewMismatch (US-009)", () => {
  test("a consistent full review clears stale mismatch evidence (AC-17)", async () => {
    const stale = record({ reviewRan: true, reviewMismatch: { kinds: ["spec"] } });
    const h = makeFeatureMachineHarness({ review: verdictOf() }, { record: stale });
    const result = await branchReviewStep(h.env, stale);
    expect("reviewMismatch" in result.patch).toBe(true);
    expect(result.patch.reviewMismatch).toBeUndefined();
  });

  test("an inconsistent review records its kinds in spec then quality order (AC-6, AC-7, AC-8)", async () => {
    const h = makeFeatureMachineHarness(
      { review: verdictOf({ spec: "fail", quality: "changes", findings: [] }) },
      { record: record() },
    );
    const result = await branchReviewStep(h.env, h.env.record);
    expect(result.patch.reviewMismatch).toEqual({ kinds: ["spec", "quality"] });
  });
});

describe("branchReReviewStep reviewMismatch (US-009)", () => {
  test("a downstream finding re-review does not clear the mismatch (AC-18)", async () => {
    const mismatch = { kinds: ["spec"] as const };
    const rec = record({
      reviewRan: true,
      reviewMismatch: mismatch,
      reviewOpen: [{ ...IMPORTANT, id: "B1" }],
      fixBase: "fix0",
      fixRan: true,
    });
    const h = makeFeatureMachineHarness(
      { reReview: { verdicts: [{ id: "B1", addressed: true, note: "" }], newFindings: [] } },
      { record: rec },
    );
    const result = await branchReReviewStep(h.env, rec);
    expect("reviewMismatch" in result.patch).toBe(false);
    expect({ ...rec, ...result.patch }.reviewMismatch).toEqual(mismatch);
  });
});
