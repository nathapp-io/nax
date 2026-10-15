/** The feature workflow's fix rounds: branch-fix rounds (#2496, nax#2547) and the final-gate repair (nax#2548). */
import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeFeatureMachineHarness } from "@test/helpers";
import { runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type { BranchReviewVerdict, ReReviewVerdict, WorkflowFeatureRecord } from "@/workflow/types";

const { GREEN, PASS } = featureMachineFixtures;
const harness = makeFeatureMachineHarness;
const limits = (maxBranchFixRounds: number, finalGateRepairRounds = 1) => ({
  limits: { maxBranchFixRounds, finalGateRepairRounds },
});

const REVIEW_B1: BranchReviewVerdict = {
  ...PASS,
  spec: "fail",
  findings: [{ kind: "spec", severity: "important", issue: "cap missing", file: "src/a.ts" }],
};
const NEW_IN_FIX = (file?: string): ReReviewVerdict => ({
  verdicts: [{ id: "B1", addressed: true, note: "" }],
  newFindings: [{ kind: "spec", severity: "important", issue: "fix broke publish", ...(file ? { file } : {}) }],
});
const ALL_ADDRESSED = (...ids: string[]): ReReviewVerdict => ({
  verdicts: ids.map((id) => ({ id, addressed: true, note: "" })),
  newFindings: [],
});
const OPEN = (id: string, newFile?: string): ReReviewVerdict => ({
  verdicts: [{ id, addressed: false, note: "" }],
  newFindings: newFile ? [{ kind: "spec", severity: "important", issue: "fix broke publish", file: newFile }] : [],
});
const PARTIAL_B1: ReReviewVerdict = {
  verdicts: [{ id: "B1", addressed: false, note: "half", residual: { issue: "symlinks bypass", file: "src/a.ts" } }],
  newFindings: [],
};
const ids = (rounds: readonly (readonly { id: string }[])[]) => rounds.map((r) => r.map((f) => f.id));

describe("branch fix rounds (#2496, nax#2547)", () => {
  test("a second round when every item is addressed and new blocking findings sit in the fix diff", async () => {
    const h = harness({
      review: REVIEW_B1,
      reReviews: [NEW_IN_FIX("src/a.ts"), ALL_ADDRESSED("B2")],
      changed: ["src/a.ts"],
    });
    const final = await runFeatureMachine(h.env);
    expect(ids(h.fixInputs)).toEqual([["B1"], ["B2"]]);
    expect(h.reReviewInputs[1]?.map((f) => f.id)).toEqual(["B2"]);
    expect(final.fixRounds).toBe(2);
    expect(final.reviewOpen).toEqual([]);
    expect(h.calls).not.toContain("adjudicate");
    expect(h.ledger.some((l) => l.startsWith("branch fix r2: 1 item(s): B2"))).toBe(true);
    expect(h.artifacts["branch-rereview-r2.json"]).toBeDefined();
  });

  test("the default cap is 2: round-2 re-review findings go to adjudicate", async () => {
    const h = harness({
      review: REVIEW_B1,
      reReviews: [NEW_IN_FIX("src/a.ts"), OPEN("B2")],
      changed: ["src/a.ts"],
    });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(2);
    expect(h.calls).toContain("adjudicate");
    expect(final.fixRounds).toBe(2);
  });

  test("a PARTIAL item gets the next round (the koda B3 case)", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [PARTIAL_B1, ALL_ADDRESSED("B1")] });
    const final = await runFeatureMachine(h.env);
    expect(ids(h.fixInputs)).toEqual([["B1"], ["B1"]]);
    expect(final.reviewOpen).toEqual([]);
    expect(h.calls).not.toContain("adjudicate");
  });

  test("an item still open plus a finding the fix introduced: the next round targets both", async () => {
    const h = harness({
      review: REVIEW_B1,
      reReviews: [OPEN("B1", "src/a.ts"), ALL_ADDRESSED("B1", "B2")],
      changed: ["src/a.ts"],
    });
    const final = await runFeatureMachine(h.env);
    expect(ids(h.fixInputs)).toEqual([["B1"], ["B1", "B2"]]);
    expect(final.reviewOpen).toEqual([]);
    expect(h.ledger.some((l) => l.startsWith("next branch fix: B1 still open; B2 introduced by the fix"))).toBe(true);
  });

  test("a new finding outside the fix diff is no target, but does not block the still-open item", async () => {
    const h = harness({
      review: REVIEW_B1,
      reReviews: [OPEN("B1", "src/other.ts"), ALL_ADDRESSED("B1")],
      changed: ["src/a.ts"],
    });
    const final = await runFeatureMachine(h.env);
    expect(ids(h.fixInputs)).toEqual([["B1"], ["B1"]]);
    expect(final.reviewOpen.map((f) => f.id)).toEqual(["B2"]);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B2"]);
  });

  test("no next round when the only new finding is outside the fix diff", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("src/other.ts")], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(h.calls).toContain("adjudicate");
  });

  test("no next round when the only new finding names no file", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX()], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
  });

  test("a git failure listing the fix diff skips the new findings and says so", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("src/a.ts")], changed: new Error("bad revision") });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(h.ledger.some((l) => l.includes("could not list the fix diff (bad revision)"))).toBe(true);
  });

  test("a git failure still re-fixes the items that stayed open", async () => {
    const h = harness({
      review: REVIEW_B1,
      reReviews: [OPEN("B1", "src/a.ts"), ALL_ADDRESSED("B1")],
      changed: new Error("bad revision"),
    });
    await runFeatureMachine(h.env);
    expect(ids(h.fixInputs)).toEqual([["B1"], ["B1"]]);
  });

  test("a file spelled ./src/a.ts still matches the fix diff", async () => {
    const h = harness({
      review: REVIEW_B1,
      reReviews: [NEW_IN_FIX("./src/a.ts"), ALL_ADDRESSED("B2")],
      changed: ["src/a.ts"],
    });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(2);
  });

  test("maxBranchFixRounds 3 runs a third round with its own step and artifact names", async () => {
    const h = harness(
      {
        review: REVIEW_B1,
        reReviews: [
          OPEN("B1", "src/a.ts"),
          {
            verdicts: [
              { id: "B1", addressed: true, note: "" },
              { id: "B2", addressed: false, note: "" },
            ],
            newFindings: [{ kind: "spec", severity: "important", issue: "again", file: "src/a.ts" }],
          },
          ALL_ADDRESSED("B2", "B3"),
        ],
        changed: ["src/a.ts"],
      },
      limits(3),
    );
    const final = await runFeatureMachine(h.env);
    expect(ids(h.fixInputs)).toEqual([["B1"], ["B1", "B2"], ["B2", "B3"]]);
    expect(final.fixRounds).toBe(3);
    expect(final.reviewOpen).toEqual([]);
    expect(h.artifacts["branch-rereview-r3.json"]).toBeDefined();
    expect(h.ledger.some((l) => l.startsWith("branch fix r3: 2 item(s): B2, B3"))).toBe(true);
  });

  test("maxBranchFixRounds 1: a PARTIAL item goes straight to adjudicate", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [PARTIAL_B1] }, limits(1));
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B1"]);
  });

  test("maxBranchFixRounds 0: no branch fix, no re-review; findings go to adjudicate and gates are reused", async () => {
    const h = harness({ review: REVIEW_B1 }, limits(0));
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["repoGates", "branchReview:seed0", "adjudicate", "publish"]);
    expect(final.fixRan).toBe(false);
    expect(h.ledger).toContain("branch fix skipped: workflow.maxBranchFixRounds is 0");
  });

  test("a follow-up round that addresses nothing ends the loop before the cap", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [OPEN("B1"), OPEN("B1"), ALL_ADDRESSED("B1")] }, limits(4));
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(2);
    expect(final.reviewOpen.map((f) => f.id)).toEqual(["B1"]);
    expect(h.ledger).toContain("branch fix stopped: round 2 addressed nothing");
  });

  test("follow-up re-reviews see the whole fix since round 1, not only the last round's edit", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [PARTIAL_B1, ALL_ADDRESSED("B1")] });
    await runFeatureMachine(h.env);
    const bases = h.calls.filter((c) => c.startsWith("branchReReview:"));
    expect(bases).toHaveLength(2);
    expect(bases[1]).toBe(bases[0]);
  });

  test("a follow-up re-review re-raising a known open finding at its file:line files no duplicate", async () => {
    const known = { kind: "spec" as const, severity: "important" as const, issue: "leak", file: "src/b.ts", line: 9 };
    const h = harness(
      {
        review: REVIEW_B1,
        reReviews: [
          { verdicts: [{ id: "B1", addressed: false, note: "" }], newFindings: [known] },
          { verdicts: [{ id: "B1", addressed: true, note: "" }], newFindings: [{ ...known, issue: "leak again" }] },
        ],
        changed: ["src/a.ts"],
      },
      limits(3),
    );
    const final = await runFeatureMachine(h.env);
    expect(final.reviewOpen.map((f) => f.id)).toEqual(["B2"]);
    expect(final.nextFindingId).toBe(3);
  });

  test("the last round clears fixTargets", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [PARTIAL_B1, ALL_ADDRESSED("B1")] });
    expect((await runFeatureMachine(h.env)).fixTargets).toBeUndefined();
  });

  test("a cap lowered before a resume is honoured: the pending round is skipped", async () => {
    const record: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
      step: "branch-fix",
      fixRan: true,
      fixRounds: 2,
      fixTargets: ["B1"],
      fixBase: "h1",
      repoGates: GREEN.summary,
      reviewOpen: [{ id: "B1", kind: "spec", severity: "important", issue: "x", file: "src/a.ts" }],
      nextFindingId: 2,
    };
    const h = harness({}, { record, ...limits(2) });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(0);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B1"]);
    expect(h.ledger).toContain("branch fix skipped: round 3 is past workflow.maxBranchFixRounds (2)");
  });

  test("resumes a pre-#2496 record (no fixRounds/fixTargets/cannotVerify) without a second round", async () => {
    const legacy: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
      step: "branch-rereview",
      fixRan: true,
      fixBase: "h1",
      reviewOpen: [{ id: "B1", kind: "spec", severity: "important", issue: "x", file: "src/a.ts" }],
      nextFindingId: 2,
    };
    const h = harness({ reReviews: [ALL_ADDRESSED("B1")] }, { record: legacy });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(0);
    expect(final.step).toBe("done");
  });
});

const RED_TEST: RepoGateRun = {
  summary: { ran: ["build", "test"], failing: ["test"] },
  findings: [{ kind: "gate", severity: "important", issue: "repo gate test failed:\nFAIL AC-9 stop keeps RUNNING" }],
};

describe("final-gate repair (nax#2548)", () => {
  test("green repo gates, a branch fix, red final gates: one repair round, then the gates run again", async () => {
    const h = harness({ review: REVIEW_B1, gates: [GREEN, RED_TEST, GREEN] });
    const final = await runFeatureMachine(h.env);
    expect(h.calls.filter((c) => c === "repoGates")).toHaveLength(3);
    expect(h.fixInputs).toHaveLength(2);
    expect(h.fixInputs[1]?.[0]?.issue).toContain("FAIL AC-9 stop keeps RUNNING");
    expect(h.fixInputs[1]?.[0]?.id).toBe("G1");
    expect(final.nextFindingId).toBe(2);
    expect(final.gateRepairRounds).toBe(1);
    expect(final.finalGates).toEqual(GREEN.summary);
    expect(final).not.toHaveProperty("finalGateFindings");
    expect(h.stepsSeen).toContain("gate-repair");
    expect(h.ledger.some((l) => l.startsWith("gate repair r1: 1 item(s): G1"))).toBe(true);
  });

  test("still red after the repair: publish keeps the red output and no second repair runs", async () => {
    const h = harness({ review: REVIEW_B1, gates: [GREEN, RED_TEST, RED_TEST] });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(2);
    expect(final.gateRepairRounds).toBe(1);
    expect(final.finalGates).toEqual(RED_TEST.summary);
    expect(final.finalGateFindings).toEqual(RED_TEST.findings);
    expect(h.calls.at(-1)).toBe("publish");
  });

  test("finalGateRepairRounds 2 allows a second repair", async () => {
    const h = harness({ review: REVIEW_B1, gates: [GREEN, RED_TEST, RED_TEST, GREEN] }, limits(2, 2));
    const final = await runFeatureMachine(h.env);
    expect(final.gateRepairRounds).toBe(2);
    expect(final.finalGates).toEqual(GREEN.summary);
  });

  test("finalGateRepairRounds 0 publishes the red gates as before", async () => {
    const h = harness({ review: REVIEW_B1, gates: [GREEN, RED_TEST] }, limits(2, 0));
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(final.finalGateFindings).toEqual(RED_TEST.findings);
    expect(final).not.toHaveProperty("gateRepairRounds");
  });

  test("repo gates already red before the fix: no repair round (the branch fix owned them)", async () => {
    const h = harness({ review: REVIEW_B1, gates: [RED_TEST, RED_TEST] });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(final.finalGateFindings).toEqual(RED_TEST.findings);
  });

  test("no stale repair excerpts on the record, green or still red after the last repair", async () => {
    const green = harness({ review: REVIEW_B1, gates: [GREEN, RED_TEST, GREEN] });
    expect((await runFeatureMachine(green.env)).gateRepairFindings).toBeUndefined();
    const red = harness({ review: REVIEW_B1, gates: [GREEN, RED_TEST, RED_TEST] });
    expect((await runFeatureMachine(red.env)).gateRepairFindings).toBeUndefined();
  });

  test("a repair cap lowered before a resume at gate-repair is honoured", async () => {
    const record: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
      step: "gate-repair",
      fixRan: true,
      fixRounds: 1,
      repoGates: GREEN.summary,
      gateRepairFindings: RED_TEST.findings,
    };
    const h = harness({ gates: [RED_TEST] }, { record, ...limits(2, 0) });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(0);
    expect(h.ledger).toContain("gate repair skipped: round 1 is past workflow.finalGateRepairRounds (0)");
    expect(final.finalGateFindings).toEqual(RED_TEST.findings);
  });

  test("a red gate with no excerpt is not repaired: there is nothing to hand the session", async () => {
    const bare: RepoGateRun = { summary: { ran: ["test"], failing: ["test"] }, findings: [] };
    const h = harness({ review: REVIEW_B1, gates: [GREEN, bare] });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(final).not.toHaveProperty("gateRepairRounds");
    expect(final.finalGates).toEqual(bare.summary);
  });

  test("resumes at gate-repair: the repair runs, then the gates", async () => {
    const record: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
      step: "gate-repair",
      fixRan: true,
      fixRounds: 1,
      repoGates: GREEN.summary,
      gateRepairFindings: RED_TEST.findings,
    };
    const h = harness({ gates: [GREEN] }, { record });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["branchFix", "repoGates", "publish"]);
    expect(h.fixInputs[0]?.map((f) => f.id)).toEqual(["G1"]);
    expect(final.gateRepairRounds).toBe(1);
  });

  test("a repair session failure is noted and the gates still run again", async () => {
    const h = harness({
      review: REVIEW_B1,
      gates: [GREEN, RED_TEST, RED_TEST],
      fix: { autoCommitted: false, dirty: false, failure: "timeout" },
    });
    await runFeatureMachine(h.env);
    expect(h.ledger).toContain("gate repair session failed: timeout");
    expect(h.calls.filter((c) => c === "repoGates")).toHaveLength(3);
  });
});
