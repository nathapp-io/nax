/**
 * US-009: the feature machine records a branch review's verdict mismatch as evidence — no B id, no fix
 * round, no gate — while every real fix path and finding count stays exactly as it was.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeFeatureMachineHarness } from "@test/helpers";
import { _approvalDeps } from "@/workflow/approval";
import { runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type { BranchReviewVerdict, WorkflowFeatureRecord, WorkflowFinding } from "@/workflow/types";

const { PASS, GREEN } = featureMachineFixtures;
const harness = makeFeatureMachineHarness;

const originalApprovalDeps = { ..._approvalDeps };
afterEach(() => {
  Object.assign(_approvalDeps, originalApprovalDeps);
});

const verdictOf = (over: Partial<BranchReviewVerdict> = {}): BranchReviewVerdict => ({ ...PASS, ...over });
const IMPORTANT = { kind: "quality" as const, severity: "important" as const, issue: "real defect" };

/** A record carrying the deferred minor `M1`, which the review's triage decides about. */
const withMinor = (over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord => ({
  ...newFeatureRecord({
    now: "t",
    seed: "seed0",
    minors: [{ id: "M1", storyId: "US-001", text: "rename tmp", triage: "leave" }],
  }),
  ...over,
});

const RED_GATE: RepoGateRun = {
  summary: { ran: ["build", "test"], failing: ["test"] },
  findings: [{ kind: "gate", severity: "important", issue: "repo gate test failed: FAIL AC-2" }],
};

const idsOf = (findings: readonly WorkflowFinding[] | undefined): string[] => (findings ?? []).map((f) => f.id);

describe("mismatch-only evidence (US-009)", () => {
  test("a quality-changes verdict with no finding dispatches no branch fix (AC-5)", async () => {
    const h = harness({ review: verdictOf({ quality: "changes" }) });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).not.toContain("branchFix");
    expect(final.step).toBe("done");
  });

  test("a spec fail with no blocking spec finding is recognized (AC-6)", async () => {
    const h = harness({ review: verdictOf({ spec: "fail" }) });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).not.toContain("branchFix");
    expect(final.reviewMismatch).toEqual({ kinds: ["spec"] });
  });

  test("a changes verdict with no blocking finding is recognized (AC-7)", async () => {
    const final = await runFeatureMachine(harness({ review: verdictOf({ quality: "changes" }) }).env);
    expect(final.reviewMismatch).toEqual({ kinds: ["quality"] });
  });

  test("both kinds persist in spec then quality order (AC-8)", async () => {
    const h = harness({ review: verdictOf({ spec: "fail", quality: "changes", findings: [] }) });
    const final = await runFeatureMachine(h.env);
    expect(final.reviewMismatch).toEqual({ kinds: ["spec", "quality"] });
  });

  test("reviewRan stays true and the review is never labelled skipped (AC-9)", async () => {
    const h = harness({ review: verdictOf({ spec: "fail" }) });
    const final = await runFeatureMachine(h.env);
    expect(final.reviewRan).toBe(true);
    expect(h.ledger.filter((line) => line.startsWith("review-skipped (branch review:"))).toEqual([]);
  });
});

describe("real work alongside a mismatch (US-009)", () => {
  test("still fixes a blocking finding and a gate finding (AC-10)", async () => {
    const h = harness({
      review: verdictOf({ spec: "fail", findings: [IMPORTANT] }),
      gates: [RED_GATE, GREEN],
    });
    const final = await runFeatureMachine(h.env);
    const first = h.fixInputs[0] ?? [];
    // The reviewer's real finding and the red gate's excerpt both ride the first fix round.
    expect(first.map((f) => f.issue)).toEqual([IMPORTANT.issue, "repo gate test failed: FAIL AC-2"]);
    expect(first.map((f) => f.id)).toEqual(["B2", "B1"]);
    expect(h.calls).toContain("branchFix");
    expect(final.reviewMismatch).toEqual({ kinds: ["spec"] });
  });

  test("still fixes fix-now minors (AC-11)", async () => {
    const review = verdictOf({ spec: "fail", minorTriage: [{ id: "M1", decision: "fix-now" }] });
    const h = harness({ review }, { record: withMinor() });
    const final = await runFeatureMachine(h.env);
    expect(idsOf(h.fixInputs[0])).toEqual(["M1"]);
    expect(final.reviewMismatch).toEqual({ kinds: ["spec"] });
  });

  test("still assigns B ids to promoted minors (AC-12)", async () => {
    const review = verdictOf({ spec: "fail", minorTriage: [{ id: "M1", decision: "promote" }] });
    const h = harness({ review }, { record: withMinor() });
    const final = await runFeatureMachine(h.env);
    expect(idsOf(h.fixInputs[0])).toEqual(["B1"]);
    expect(h.fixInputs[0]?.[0]?.issue).toBe("US-001: rename tmp");
    expect(final.reviewMismatch).toEqual({ kinds: ["spec"] });
  });

  test("retains a spec mismatch when a quality minor is promoted (AC-13)", async () => {
    const review = verdictOf({
      spec: "fail",
      quality: "changes",
      findings: [],
      minorTriage: [{ id: "M1", decision: "promote" }],
    });
    const final = await runFeatureMachine(harness({ review }, { record: withMinor() }).env);
    expect(final.reviewMismatch).toEqual({ kinds: ["spec", "quality"] });
  });
});

describe("the shared sentence source (US-009)", () => {
  test("the branch-review step writes the ledger text through _approvalDeps (AC-15)", async () => {
    const asked: string[][] = [];
    _approvalDeps.branchMismatchReasons = (kinds) => {
      asked.push([...kinds]);
      return ["seam sentence one", "seam sentence two"];
    };
    const h = harness({ review: verdictOf({ spec: "fail", quality: "changes", findings: [] }) });
    const final = await runFeatureMachine(h.env);
    expect(asked).toEqual([["spec", "quality"]]);
    expect(h.ledger).toContain("seam sentence one");
    expect(h.ledger).toContain("seam sentence two");
    expect(final.reviewMismatch).toEqual({ kinds: ["spec", "quality"] });
  });
});

describe("resumed records (US-009)", () => {
  test("resuming downstream of branch review keeps the mismatch and launches nothing for it (AC-16)", async () => {
    const resumed = newFeatureRecord({ now: "t", seed: "seed0", minors: [] });
    const record: WorkflowFeatureRecord = {
      ...resumed,
      step: "branch-fix",
      reviewRan: true,
      reviewMismatch: { kinds: ["spec"] },
    };
    const h = harness({}, { record });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).not.toContain("branchFix");
    expect(final.reviewMismatch).toEqual({ kinds: ["spec"] });
    expect(final.step).toBe("done");
  });
});
