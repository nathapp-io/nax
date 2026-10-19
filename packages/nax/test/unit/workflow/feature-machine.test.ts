import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeDoneStory, makeFeatureMachineHarness } from "@test/helpers";
import { runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type { BranchReviewVerdict, ReReviewVerdict, WorkflowFeatureRecord } from "@/workflow/types";

const { GREEN, PASS } = featureMachineFixtures;
const harness = makeFeatureMachineHarness;
const ONE_ROUND = { maxBranchFixRounds: 1, finalGateRepairRounds: 1 };
const done = makeDoneStory;
const RED_LINT: RepoGateRun = {
  summary: { ran: ["build", "lint"], failing: ["lint"] },
  findings: [{ kind: "gate", severity: "important", issue: "repo gate lint failed:\nno-var" }],
};
const RED_TEST: RepoGateRun = {
  summary: { ran: ["build", "test"], failing: ["test"] },
  findings: [
    { kind: "gate", severity: "important", issue: "repo gate test failed:\nFAIL src/adds.test.ts > adds 1 + 1" },
  ],
};

describe("runFeatureMachine", () => {
  // US-006 (nax#2527): the branch reviewer sees the repo gates the record already holds.
  test("the record's repo gates reach the branch review facts (AC-16)", async () => {
    const record: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
      step: "branch-review",
      repoGates: { ran: ["lint"], failing: [] },
    };
    const h = harness({}, { record });
    await runFeatureMachine(h.env);
    expect(h.reviewFacts[0]?.repoGates).toEqual({ ran: ["lint"], failing: [] });
  });

  test("branch-review.json carries the same B-ids as the record; cannot-verify kept (#2496)", async () => {
    const review: BranchReviewVerdict = {
      ...PASS,
      spec: "fail",
      findings: [
        { kind: "spec", severity: "important", issue: "missing refund cap", file: "src/r.ts", line: 4 },
        { kind: "quality", severity: "minor", issue: "rename tmp" },
      ],
      cannotVerify: ["CI-only path"],
    };
    const h = harness({ review });
    const final = await runFeatureMachine(h.env);
    const written: unknown = h.artifacts["branch-review.json"];
    expect(written).toMatchObject({ findings: [{ id: "B1" }, { kind: "quality" }] });
    expect(final.cannotVerify).toEqual(["CI-only path"]);
    expect(h.artifacts["branch-rereview.json"]).toBeDefined();
  });

  test("a branch cannotVerify line that only defers to the repository gates is dropped from the record", async () => {
    const review: BranchReviewVerdict = {
      ...PASS,
      cannotVerify: ["Repository gates after the branch fix have not run yet", "CI-only path"],
    };
    const h = harness({ review });
    const final = await runFeatureMachine(h.env);
    expect(final.cannotVerify).toEqual(["CI-only path"]);
    expect(h.artifacts["branch-review.json"]).toMatchObject({ cannotVerify: ["CI-only path"] });
    expect(h.ledger).toContain(
      "cannot-verify dropped (a nax gate covers it): Repository gates after the branch fix have not run yet",
    );
  });

  test("clean branch: no fix, no re-review, no adjudication; final gates reuse step 1", async () => {
    const h = harness({});
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["repoGates", "branchReview:seed0", "publish"]);
    expect(h.stepsSeen).toEqual([
      "repo-gates",
      "branch-review",
      "branch-fix",
      "branch-rereview",
      "adjudicate",
      "final-gates",
      "publish",
      "done",
    ]);
    expect(h.updates).toHaveLength(7);
    expect(final).toMatchObject({
      step: "done",
      reviewRan: true,
      finalGates: GREEN.summary,
      outcome: "ready",
      ci: "pending",
      url: "https://gh/pr/1",
      passed: true,
    });
    expect(final.head).toBe("h3");
    expect(final.timings["repo-gates"]).toBe(5);
  });

  test("findings, a fix-now minor, a red gate and a gate-open story all reach the one fix (P4-R7)", async () => {
    const h = harness(
      {
        gates: [RED_LINT, GREEN],
        review: {
          ...PASS,
          quality: "changes",
          findings: [
            { kind: "quality", severity: "important", issue: "US-2 skips the US-1 lock" },
            { kind: "quality", severity: "minor", issue: "naming nit" },
          ],
          minorTriage: [{ id: "M1", decision: "fix-now" }],
        },
        reReview: {
          verdicts: [
            { id: "B3", addressed: false, note: "still skipped" },
            { id: "M1", addressed: false, note: "" },
          ],
          newFindings: [
            { kind: "quality", severity: "critical", issue: "new race" },
            { kind: "quality", severity: "minor", issue: "typo" },
          ],
        },
      },
      {
        record: {
          ...newFeatureRecord({
            now: "t",
            seed: "seed0",
            minors: [{ id: "M1", storyId: "US-001", text: "rename", triage: "leave" }],
          }),
        },
        stories: [done("US-001"), done("US-002", { state: "complete-gate-open", reason: "red: lint" })],
        // One round: this test is about what reaches the first fix; later rounds are covered in feature-machine-fix-rounds.
        limits: ONE_ROUND,
      },
    );
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs[0]?.map((f) => f.id)).toEqual(["B3", "M1", "B1", "B2"]);
    expect(h.fixInputs[0]?.find((f) => f.id === "B2")?.issue).toContain("US-002 ended with a red gate (red: lint)");
    expect(h.reReviewInputs[0]?.map((f) => f.id)).toEqual(["B3", "M1"]);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B3", "B4"]);
    expect(final.minors).toEqual([{ id: "M1", storyId: "US-001", text: "rename", triage: "leave" }]);
    expect(final.newMinors).toEqual(["naming nit", "typo"]);
    expect(final.rulings).toHaveLength(2);
    expect(final.finalGates).toEqual(GREEN.summary);
    expect(h.calls.filter((c) => c === "repoGates")).toHaveLength(2);
    expect(h.ledger).toContain("repo gates red: lint");
  });

  test("no seed: the branch review is skipped with a ledger line; review did not run (P4-R15)", async () => {
    const h = harness({}, { record: newFeatureRecord({ now: "t", seed: null, minors: [] }) });
    const final = await runFeatureMachine(h.env);
    expect(h.calls.some((c) => c.startsWith("branchReview"))).toBe(false);
    expect(h.ledger).toContain("review-skipped (branch review: no seed)");
    expect(final.reviewRan).toBe(false);
  });

  // A branch reviewer that repeats a deferred minor as its own minor finding ("M2: …", "DEFERRED M4 …")
  // listed that minor twice, and kept the copy listed after the branch fix addressed the original.
  test("a branch-review minor restating a deferred minor by its id never reaches newMinors", async () => {
    const h = harness(
      {
        review: {
          ...PASS,
          findings: [
            { kind: "quality", severity: "minor", issue: "M2: every lexical failure rebuilds the index" },
            { kind: "quality", severity: "minor", issue: "DEFERRED M4 (reported, not blocking): no doc comment" },
            { kind: "quality", severity: "minor", issue: "M7: an id nax never assigned stays a new minor" },
            { kind: "quality", severity: "minor", issue: "providerSlotKey hard-codes the literal" },
          ],
          minorTriage: [
            { id: "M2", decision: "fix-now" },
            { id: "M4", decision: "leave" },
          ],
        },
        reReview: { verdicts: [{ id: "M2", addressed: true, note: "fixed" }], newFindings: [] },
      },
      {
        record: newFeatureRecord({
          now: "t",
          seed: "seed0",
          minors: [
            { id: "M2", storyId: "US-002", text: "lexical rebuilds on any failure", triage: "leave" },
            { id: "M4", storyId: "US-003", text: "no doc comment", triage: "leave" },
          ],
        }),
        limits: ONE_ROUND,
      },
    );
    const final = await runFeatureMachine(h.env);
    expect(final.newMinors).toEqual([
      "M7: an id nax never assigned stays a new minor",
      "providerSlotKey hard-codes the literal",
    ]);
    expect(final.minors.map((m) => [m.id, m.triage])).toEqual([
      ["M2", "fix-now"],
      ["M4", "leave"],
    ]);
    expect(h.ledger).toContain("restated deferred minor M2 dropped: M2: every lexical failure rebuilds the index");
  });

  test("the re-review drops only restatements of the fix-now minors it was shown", async () => {
    const h = harness(
      {
        review: { ...PASS, minorTriage: [{ id: "M1", decision: "fix-now" }] },
        reReview: {
          verdicts: [{ id: "M1", addressed: true, note: "fixed" }],
          newFindings: [
            { kind: "quality", severity: "minor", issue: "M1: the cache key still collides with the cooldown key" },
            { kind: "quality", severity: "minor", issue: "M2: the retry log line has a typo" },
          ],
        },
      },
      {
        record: newFeatureRecord({
          now: "t",
          seed: "seed0",
          minors: [
            { id: "M1", storyId: "US-001", text: "cache key collides with the cooldown key", triage: "leave" },
            { id: "M2", storyId: "US-002", text: "retry backoff is not jittered", triage: "leave" },
          ],
        }),
        limits: ONE_ROUND,
      },
    );
    const final = await runFeatureMachine(h.env);
    expect(final.newMinors).toEqual(["M2: the retry log line has a typo"]);
  });

  test("an unparseable branch review: skipped, but red gates still go to the fix", async () => {
    const h = harness({ gates: [RED_LINT, GREEN], review: null });
    const final = await runFeatureMachine(h.env);
    expect(h.ledger).toContain("review-skipped (branch review: unparseable reply)");
    expect(h.fixInputs[0]?.map((f) => f.id)).toEqual(["B1"]);
    expect(final.reviewRan).toBe(false);
    expect(h.calls.some((c) => c.startsWith("branchReReview"))).toBe(false);
  });

  test("a re-review that does not run leaves every review finding open for adjudication", async () => {
    const h = harness({
      review: { ...PASS, findings: [{ kind: "spec", severity: "important", issue: "AC-2 unwired" }] },
      reReview: null,
    });
    await runFeatureMachine(h.env);
    expect(h.ledger).toContain("review-skipped (branch re-review: timeout)");
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B1"]);
  });

  test("a re-review verdict that omits an item keeps it open: finding adjudicated, fix-now minor becomes leave", async () => {
    const h = harness(
      {
        review: {
          ...PASS,
          quality: "changes",
          findings: [
            { kind: "quality", severity: "important", issue: "a" },
            { kind: "quality", severity: "important", issue: "b" },
          ],
          minorTriage: [{ id: "M1", decision: "fix-now" }],
        },
        reReview: { verdicts: [{ id: "B1", addressed: true, note: "" }], newFindings: [] },
      },
      {
        record: newFeatureRecord({
          now: "t",
          seed: "seed0",
          minors: [{ id: "M1", storyId: "US-001", text: "rename", triage: "leave" }],
        }),
      },
    );
    const final = await runFeatureMachine(h.env);
    expect(h.reReviewInputs[0]?.map((f) => f.id)).toEqual(["B1", "B2", "M1"]);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B2"]);
    expect(final.minors.find((m) => m.id === "M1")?.triage).toBe("leave");
  });

  test("the re-review gets the HEAD recorded just before the fix as its base", async () => {
    const h = harness({ review: { ...PASS, findings: [{ kind: "spec", severity: "important", issue: "x" }] } });
    await runFeatureMachine(h.env);
    const fixAt = h.calls.indexOf("branchFix");
    expect(h.calls[fixAt + 1]).toMatch(/^branchReReview:h\d+$/);
  });

  test("a fix session failure is ledgered and the workflow goes on", async () => {
    const h = harness({
      review: { ...PASS, findings: [{ kind: "spec", severity: "important", issue: "x" }] },
      fix: { failure: "quota", autoCommitted: false, dirty: false },
    });
    const final = await runFeatureMachine(h.env);
    expect(h.ledger).toContain("branch fix session failed: quota");
    expect(final.step).toBe("done");
  });

  test("a fix that left the tree dirty is ledgered", async () => {
    const h = harness({
      review: { ...PASS, findings: [{ kind: "spec", severity: "important", issue: "x" }] },
      fix: { autoCommitted: false, dirty: true },
    });
    await runFeatureMachine(h.env);
    expect(h.ledger).toContain("branch fix left uncommitted edits: the auto-commit failed");
  });

  test("resume at adjudicate: earlier steps never run again (P4-R1)", async () => {
    const record: WorkflowFeatureRecord = {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      step: "adjudicate",
      reviewRan: true,
      fixRan: true,
      repoGates: GREEN.summary,
      reviewOpen: [{ id: "B1", kind: "quality", severity: "important", issue: "x" }],
    };
    const h = harness({}, { record });
    await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["adjudicate", "repoGates", "publish"]);
  });

  test("an aborted run throws before the next step and runs nothing", async () => {
    const h = harness({}, { aborted: true });
    await expect(runFeatureMachine(h.env)).rejects.toThrow("aborted");
    expect(h.calls).toEqual([]);
  });

  test("passed is false when a story is not-run, even if publish succeeds", async () => {
    const h = harness({}, { stories: [done("US-001", { state: "not-run" })] });
    expect((await runFeatureMachine(h.env)).passed).toBe(false);
  });

  test("a red final gate keeps its output in finalGateFindings and the ledger points at it (nax#2484)", async () => {
    const h = harness({ gates: [RED_TEST, RED_TEST] });
    const final = await runFeatureMachine(h.env);
    expect(final.finalGates).toEqual(RED_TEST.summary);
    expect(final.finalGateFindings).toEqual(RED_TEST.findings);
    expect(final.finalGateFindings?.[0]?.issue).toContain("FAIL src/adds.test.ts > adds 1 + 1");
    expect(h.ledger).toContain("final gates red: test (output in result.json featureWorkflow.finalGateFindings)");
  });

  test("a green final gate writes no finalGateFindings and no pointer line (nax#2484)", async () => {
    const h = harness({ gates: [RED_TEST, GREEN] });
    const final = await runFeatureMachine(h.env);
    expect(final.finalGates).toEqual(GREEN.summary);
    expect(final).not.toHaveProperty("finalGateFindings");
    expect(h.ledger.some((line) => line.includes("final gates red"))).toBe(false);
  });
});

// US-003 (nax#2532): what the branch reviewer did not read reaches the record, the ledger and publish.
describe("branch review coverage (US-003)", () => {
  const BRANCH_REVIEW_STEP: WorkflowFeatureRecord = {
    ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
    step: "branch-review",
  };

  test("an incomplete verdict is persisted as reviewUnread (AC-20)", async () => {
    const h = harness({ review: { ...PASS, unreadFiles: ["src/b.ts"] } }, { record: BRANCH_REVIEW_STEP });
    const final = await runFeatureMachine(h.env);

    expect(final.reviewUnread).toEqual(["src/b.ts"]);
    expect(h.updates.at(-1)?.reviewUnread).toEqual(["src/b.ts"]);
  });

  test("the unread files are written to the ledger once, in the shared phrasing (AC-21)", async () => {
    const h = harness({ review: { ...PASS, unreadFiles: ["src/b.ts"] } }, { record: BRANCH_REVIEW_STEP });
    await runFeatureMachine(h.env);

    const notes = h.ledger.filter((line) => line.includes("branch review did not read"));
    expect(notes).toEqual(["branch review did not read 1 changed file(s): src/b.ts"]);
  });

  test("a verdict with no unread files leaves the record without reviewUnread (AC-22)", async () => {
    const h = harness({}, { record: BRANCH_REVIEW_STEP });
    const final = await runFeatureMachine(h.env);

    expect(final).not.toHaveProperty("reviewUnread");
    expect(h.ledger.some((line) => line.includes("branch review did not read"))).toBe(false);
  });
});

const SAME_PLACE_B1: BranchReviewVerdict = {
  ...PASS,
  spec: "fail",
  findings: [{ kind: "spec", severity: "important", issue: "cap missing", file: "src/a.ts", line: 53 }],
};
/** US-004 (nax#2524): the fix resolved part of B1, and the reviewer filed the remainder again. */
const PARTIAL_B1 = (severity: "critical" | "minor" = "critical"): ReReviewVerdict => ({
  verdicts: [
    {
      id: "B1",
      addressed: false,
      note: "half done",
      residual: { issue: "symlinks still bypass", file: "src/a.ts", line: 53 },
    },
  ],
  newFindings: [{ kind: "spec", severity, issue: "symlinks still bypass", file: "src/a.ts", line: 53 }],
});

describe("branch re-review PARTIAL (US-004)", () => {
  test("B1 stays open with the residual's issue and the restatement is not filed (AC-17)", async () => {
    const h = harness({ review: SAME_PLACE_B1, reReview: PARTIAL_B1() });
    const final = await runFeatureMachine(h.env);
    expect(final.reviewOpen).toHaveLength(1);
    expect(final.reviewOpen[0]?.id).toBe("B1");
    expect(final.reviewOpen[0]?.issue).toBe("symlinks still bypass");
  });

  test("adjudicate sees exactly one item, the residual finding (AC-18)", async () => {
    const h = harness({ review: SAME_PLACE_B1, reReview: PARTIAL_B1() });
    await runFeatureMachine(h.env);
    expect(h.adjudicated).toHaveLength(1);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B1"]);
  });

  test("the restatement's id is never spent, and the artifact keeps the assigned findings", async () => {
    const h = harness({ review: SAME_PLACE_B1, reReview: PARTIAL_B1() });
    const final = await runFeatureMachine(h.env);
    expect(final.nextFindingId).toBe(2);
    expect(h.artifacts["branch-rereview.json"]).toMatchObject({ newFindings: [] });
  });

  test("a restated minor never reaches newMinors", async () => {
    const h = harness({ review: SAME_PLACE_B1, reReview: PARTIAL_B1("minor") });
    const final = await runFeatureMachine(h.env);
    expect(final.newMinors).toEqual([]);
    expect(h.artifacts["branch-rereview.json"]).toMatchObject({ newFindings: [] });
  });

  test("a residual at another location keeps a new finding there", async () => {
    const verdict: ReReviewVerdict = {
      ...PARTIAL_B1(),
      newFindings: [{ kind: "spec", severity: "critical", issue: "broke publish", file: "src/a.ts", line: 60 }],
    };
    const h = harness({ review: SAME_PLACE_B1, reReview: verdict }, { limits: ONE_ROUND });
    const final = await runFeatureMachine(h.env);
    // One round (nax#2547 would otherwise re-fix B1): the new finding goes to adjudication with it.
    expect(final.reviewOpen.map((f) => f.id)).toEqual(["B1", "B2"]);
    expect(final.reviewOpen.map((f) => f.issue)).toEqual(["symlinks still bypass", "broke publish"]);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B1", "B2"]);
    expect(h.fixInputs).toHaveLength(1);
  });
});
