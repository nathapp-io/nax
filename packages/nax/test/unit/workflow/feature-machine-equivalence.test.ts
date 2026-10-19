/**
 * G0 (step-graph equivalence): the feature machine's characterization catalogue. One scenario per
 * scripted run of `makeFeatureMachineHarness`, each asserting the behaviour the step-graph port must
 * reproduce and then holding the whole recorded trace against its committed golden.
 *
 * The trace is taken at the machine's injection seams (`FeatureEnv.steps`, `FeatureEnv.sink`) plus the
 * `workflow` run log, so it describes behaviour and not implementation. Goldens live in
 * `test/fixtures/workflow-equivalence/feature/<scenario>.json` and are regenerated only deliberately:
 * `NAX_UPDATE_WORKFLOW_GOLDEN=1 bun test test/unit/workflow/feature-machine-equivalence.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  assertDefined,
  compareWithGolden,
  featureMachineFixtures,
  makeFeatureMachineHarness,
  recordFeatureTrace,
  type TraceLogEvent,
  type WorkflowTrace,
} from "@test/helpers";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type { BranchReviewVerdict, FeatureStep, ReReviewVerdict, WorkflowFeatureRecord } from "@/workflow/types";

const { GREEN, PASS, FIXED, PUBLISHED } = featureMachineFixtures;
const harness = makeFeatureMachineHarness;

/** The `steps` seam methods a trace called, in invocation order. */
const callsOf = (trace: WorkflowTrace): string[] =>
  trace.events.flatMap((event) => (event.kind === "call" ? [event.method] : []));

/** The `sink.step` labels a trace recorded, in order. */
const stepsOf = (trace: WorkflowTrace): FeatureStep[] =>
  trace.events.flatMap((event) => (event.kind === "step" ? [event.step] : []));

/** The `sink.ledger` texts a trace recorded, in order. */
const ledgerOf = (trace: WorkflowTrace): string[] =>
  trace.events.flatMap((event) => (event.kind === "ledger" ? [event.text] : []));

const logsOf = (trace: WorkflowTrace): TraceLogEvent[] =>
  trace.events.filter((event): event is TraceLogEvent => event.kind === "log");

/** The last record the machine persisted; `runFeatureMachine` returns that same object at `done`. */
function finalRecordOf(recorded: { readonly updates: readonly WorkflowFeatureRecord[] }): WorkflowFeatureRecord {
  const final = recorded.updates.at(-1);
  assertDefined(final, "the final feature record");
  return final;
}

/** A resume record: the machine's own `newFeatureRecord`, with the state the scenario starts from. */
const recordWith = (over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
  ...over,
});

const ONE_IMPORTANT = "issue one";

const REVIEW_B1: BranchReviewVerdict = {
  ...PASS,
  spec: "fail",
  findings: [{ kind: "spec", severity: "important", issue: ONE_IMPORTANT, file: "src/a.ts" }],
};

/** Two blocking findings and one minor: only the blocking pair is the fix's business. */
const TWO_IMPORTANT_ONE_MINOR: BranchReviewVerdict = {
  ...PASS,
  spec: "fail",
  quality: "changes",
  findings: [
    { kind: "spec", severity: "important", issue: ONE_IMPORTANT, file: "src/a.ts" },
    { kind: "quality", severity: "important", issue: "issue two", file: "src/b.ts" },
    { kind: "quality", severity: "minor", issue: "naming nit", file: "src/c.ts" },
  ],
};

const ALL_ADDRESSED = (...ids: string[]): ReReviewVerdict => ({
  verdicts: ids.map((id) => ({ id, addressed: true, note: "" })),
  newFindings: [],
});

const OPEN = (id: string): ReReviewVerdict => ({ verdicts: [{ id, addressed: false, note: "" }], newFindings: [] });

const RED_LINT: RepoGateRun = {
  summary: { ran: ["build", "lint", "test"], failing: ["lint"] },
  findings: [{ kind: "gate", severity: "important", issue: "repo gate lint failed: 3 problems" }],
};

const RED_TEST: RepoGateRun = {
  summary: { ran: ["build", "lint", "test"], failing: ["test"] },
  findings: [{ kind: "gate", severity: "important", issue: "repo gate test failed: FAIL AC-2" }],
};

const LIMITS = { maxBranchFixRounds: 2, finalGateRepairRounds: 1 };

describe("clean and fixed branches", () => {
  test("clean-pass: the eight steps, no branch fix, and a ready publish", async () => {
    const h = harness({ review: PASS, published: PUBLISHED });
    const trace = await recordFeatureTrace("clean-pass", h);
    // AC-1: the step sequence a clean run walks, in order.
    expect(stepsOf(trace)).toEqual([
      "repo-gates",
      "branch-review",
      "branch-fix",
      "branch-rereview",
      "adjudicate",
      "final-gates",
      "publish",
      "done",
    ]);
    // AC-2: the fix step is entered but opens no session, because nothing is open.
    expect(callsOf(trace)).not.toContain("branchFix");
    await compareWithGolden(trace);
  });

  test("one-fix-round: exactly one branch fix, carrying both important findings and not the minor", async () => {
    const h = harness({ review: TWO_IMPORTANT_ONE_MINOR });
    const trace = await recordFeatureTrace("one-fix-round", h);
    // AC-3: one fix, targeting the two blocking findings, in review order.
    expect(h.calls.filter((call) => call === "branchFix")).toHaveLength(1);
    const first = h.fixInputs[0];
    assertDefined(first, "the first branch fix argument");
    expect(first.map((finding) => finding.id)).toEqual(["B1", "B2"]);
    expect(first.map((finding) => finding.issue)).toEqual([ONE_IMPORTANT, "issue two"]);
    expect(first.map((finding) => finding.severity)).toEqual(["important", "important"]);
    await compareWithGolden(trace);
  });

  test("two-fix-rounds: the second round runs when the first re-review leaves the finding open", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [OPEN("B1"), ALL_ADDRESSED("B1")] }, { limits: LIMITS });
    const trace = await recordFeatureTrace("two-fix-rounds", h);
    // AC-4: two rounds, both aimed at the one still-open finding.
    expect(h.calls.filter((call) => call === "branchFix")).toHaveLength(2);
    expect(h.fixInputs.map((round) => round.map((finding) => finding.id))).toEqual([["B1"], ["B1"]]);
    await compareWithGolden(trace);
  });

  test("residual-adjudicated: the finding past the round cap is adjudicated and the run still publishes", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [OPEN("B1"), OPEN("B1")] }, { limits: LIMITS });
    const trace = await recordFeatureTrace("residual-adjudicated", h);
    // AC-5: the residual is what the adjudication was asked about.
    const adjudicated = h.adjudicated[0];
    assertDefined(adjudicated, "the adjudicate argument");
    expect(adjudicated.map((finding) => finding.id)).toEqual(["B1"]);
    // AC-6: a residual is not the end of the run.
    expect(callsOf(trace)).toContain("publish");
    expect(finalRecordOf(h).step).toBe("done");
    await compareWithGolden(trace);
  });
});

describe("repo and final gates", () => {
  test("repo-gates-red: the gate finding reaches the first fix and the ledger names the gate", async () => {
    const h = harness({ gates: [RED_LINT, GREEN], review: PASS });
    const trace = await recordFeatureTrace("repo-gates-red", h);
    // AC-7: the red gate's excerpt is what the first fix is handed.
    const first = h.fixInputs[0];
    assertDefined(first, "the first branch fix argument");
    expect(first.map((finding) => finding.kind)).toEqual(["gate"]);
    expect(first.map((finding) => finding.issue)).toContain("repo gate lint failed: 3 problems");
    // AC-8: and the ledger says which gate was red.
    expect(ledgerOf(trace).some((text) => text.includes("repo gates red: lint"))).toBe(true);
    await compareWithGolden(trace);
  });

  test("final-gates-repair: green, red, green gate runs take a gate-repair step between them", async () => {
    const h = harness({ review: REVIEW_B1, gates: [GREEN, RED_TEST, GREEN] });
    const trace = await recordFeatureTrace("final-gates-repair", h);
    // AC-9: the repair step runs, and the gates therefore run three times.
    expect(stepsOf(trace)).toContain("gate-repair");
    expect(callsOf(trace).filter((call) => call === "repoGates")).toHaveLength(3);
    expect(h.fixInputs).toHaveLength(2);
    await compareWithGolden(trace);
  });
});

describe("skipped work", () => {
  test("review-not-ran: a review that did not run is recorded, never read as clean", async () => {
    const h = harness({ review: null });
    const trace = await recordFeatureTrace("review-not-ran", h);
    // AC-10: the record says the review did not run.
    expect(finalRecordOf(h).reviewRan).toBe(false);
    // AC-11: and the ledger says why.
    expect(ledgerOf(trace)).toContain("review-skipped (branch review: unparseable reply)");
    await compareWithGolden(trace);
  });

  test("rereview-timeout: a timed-out re-review marks the fix commits unreviewed", async () => {
    const h = harness({ review: REVIEW_B1, reReview: null });
    const trace = await recordFeatureTrace("rereview-timeout", h);
    // AC-12: the skipped re-review is on the record, so publish cannot read it as a reviewed fix.
    expect(finalRecordOf(h).reReviewSkipped).toBe(true);
    await compareWithGolden(trace);
  });

  test("branch-review-empty-seed: an empty seed skips the review and says so", async () => {
    const h = harness({}, { record: newFeatureRecord({ now: "t", seed: "", minors: [] }) });
    const trace = await recordFeatureTrace("branch-review-empty-seed", h);
    // AC-26: no seed, no review session.
    expect(callsOf(trace)).not.toContain("branchReview");
    // AC-27: and the skip is in the ledger.
    expect(ledgerOf(trace)).toContain("review-skipped (branch review: no seed)");
    await compareWithGolden(trace);
  });

  test("head-unreadable: no base means no fix, and every later HEAD read warns into the trace", async () => {
    const h = harness({ review: REVIEW_B1 });
    // The harness file stays as it is: the scenario spreads its env and replaces the one seam.
    const env: FeatureEnv = {
      ...h.env,
      steps: {
        ...h.env.steps,
        head: async () => {
          throw new Error("git");
        },
      },
    };
    const trace = await recordFeatureTrace("head-unreadable", { env });
    // AC-31: a fix with no base would have no re-review, so none runs.
    expect(callsOf(trace)).not.toContain("branchFix");
    // AC-32: the skip is in the ledger, and every HEAD read after it says so in the log.
    expect(ledgerOf(trace).some((text) => text.includes("branch fix skipped: HEAD could not be read"))).toBe(true);
    const warnings = logsOf(trace).filter((event) => event.level === "warn");
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.every((event) => event.data?.error === "git")).toBe(true);
    await compareWithGolden(trace);
  });
});

describe("cost limit and abort", () => {
  test("cost-stop-before-review: past the limit from the start, no review, and the run still publishes", async () => {
    const h = harness({ review: REVIEW_B1 }, { costExceeded: () => true });
    const trace = await recordFeatureTrace("cost-stop-before-review", h);
    // AC-13: the review is an agent step, so it does not run.
    expect(callsOf(trace)).not.toContain("branchReview");
    // AC-14: and the record says why the run cut short.
    expect(finalRecordOf(h).costLimited).toBe(true);
    // AC-15: publishing is not an agent step: the feature still reaches its outcome.
    expect(callsOf(trace)).toContain("publish");
    await compareWithGolden(trace);
  });

  test("cost-stop-before-fix: the limit crossing after the review stops the fix", async () => {
    // The harness records `branchReview:<seed>`, so the predicate has to accept the tagged call.
    const afterReview = (calls: readonly string[]): boolean => calls.some((call) => call.startsWith("branchReview"));
    const h = harness({ review: REVIEW_B1 }, { costExceeded: afterReview });
    const trace = await recordFeatureTrace("cost-stop-before-fix", h);
    // AC-16: the fix would spend, so it is skipped.
    expect(callsOf(trace)).not.toContain("branchFix");
    // AC-17: and the record is marked cost limited.
    expect(finalRecordOf(h).costLimited).toBe(true);
    await compareWithGolden(trace);
  });

  test("aborted: no call events at all, and the run ends in WORKFLOW_ABORTED", async () => {
    const trace = await recordFeatureTrace("aborted", harness({}, { aborted: true }));
    // AC-18: the abort is checked before the first step, so no seam was ever entered.
    expect(trace.events.filter((event) => event.kind === "call")).toEqual([]);
    // AC-19: the machine throws, and the recorder keeps that as the trace's end.
    expect(trace.end).toEqual({
      threw: { code: "WORKFLOW_ABORTED", message: "Run aborted during the feature workflow" },
    });
    await compareWithGolden(trace);
  });
});

describe("resume", () => {
  test("resume-at-rereview: starts at the re-review, re-reads no review, and gates run once after it", async () => {
    const record = recordWith({
      step: "branch-rereview",
      reviewOpen: [{ id: "B1", kind: "spec", severity: "important", issue: ONE_IMPORTANT, file: "src/a.ts" }],
      nextFindingId: 2,
      fixBase: "h1",
      fixRan: true,
      fixRounds: 1,
      repoGates: GREEN.summary,
    });
    const h = harness({}, { record });
    const trace = await recordFeatureTrace("resume-at-rereview", h);
    const calls = callsOf(trace);
    // AC-20: the resume picks up where the record left off.
    expect(stepsOf(trace)[0]).toBe("branch-rereview");
    // AC-21: a run resumed after the review does not review again.
    expect(calls).not.toContain("branchReview");
    // AC-22: the fix ran, so final-gates re-runs the gates — once, and only after the re-review.
    expect(calls.filter((call) => call === "repoGates")).toHaveLength(1);
    // Both calls must exist: indexOf -1 from a skipped re-review would pass the order check vacuously.
    const rereviewAt = calls.findIndex((call) => call === "branchReReview");
    const gatesAt = calls.findIndex((call) => call === "repoGates");
    expect(rereviewAt).toBeGreaterThan(-1);
    expect(gatesAt).toBeGreaterThan(rereviewAt);
    await compareWithGolden(trace);
  });
});

describe("publish outcomes", () => {
  test("publish-draft-ci-failed: a draft held by a failed CI is recorded as such", async () => {
    const h = harness({
      published: { outcome: "draft", ci: "failed", url: "https://gh/pr/1", reasons: ["CI failed on the branch"] },
    });
    const trace = await recordFeatureTrace("publish-draft-ci-failed", h);
    const final = finalRecordOf(h);
    // AC-23 / AC-24: both halves of the outcome survive onto the record.
    expect(final.outcome).toBe("draft");
    expect(final.ci).toBe("failed");
    await compareWithGolden(trace);
  });

  test("publish-local-only: a feature kept local is recorded as such", async () => {
    const h = harness({ published: { outcome: "local-only", ci: "skipped", reasons: ["branch is not publishable"] } });
    const trace = await recordFeatureTrace("publish-local-only", h);
    // AC-25: the outcome is the step's, not a default.
    expect(finalRecordOf(h).outcome).toBe("local-only");
    await compareWithGolden(trace);
  });
});

describe("fix failure and triage", () => {
  test("branch-fix-session-failed: the failed session, its auto-commit and the leftover edits are all recorded", async () => {
    const h = harness({
      review: REVIEW_B1,
      fix: { ...FIXED, failure: "crashed", autoCommitted: true, dirty: true },
    });
    const trace = await recordFeatureTrace("branch-fix-session-failed", h);
    const ledger = ledgerOf(trace);
    // AC-28 / AC-29 / AC-30: three separate facts, three separate lines.
    expect(ledger).toContain("branch fix session failed: crashed");
    expect(ledger).toContain("auto-committed the branch fix's edits");
    expect(ledger).toContain("branch fix left uncommitted edits: the auto-commit failed");
    await compareWithGolden(trace);
  });

  test("fix-now-minor: a deferred minor triaged fix-now is handed to the first fix", async () => {
    const h = harness(
      { review: { ...PASS, minorTriage: [{ id: "M1", decision: "fix-now" }] } },
      {
        record: newFeatureRecord({
          now: "t",
          seed: "seed0",
          minors: [{ id: "M1", storyId: "US-001", text: "rename the helper", triage: "leave" }],
        }),
      },
    );
    const trace = await recordFeatureTrace("fix-now-minor", h);
    // AC-33: the minor is fixed now, spelled the way the fix session is shown one.
    const first = h.fixInputs[0];
    assertDefined(first, "the first branch fix argument");
    expect(first.map((finding) => finding.id)).toEqual(["M1"]);
    expect(first[0]?.issue).toBe("US-001: rename the helper");
    await compareWithGolden(trace);
  });

  test("quality-floor: a changes verdict with only a minor opens a synthetic blocking finding", async () => {
    const h = harness({
      review: { ...PASS, quality: "changes", findings: [{ kind: "quality", severity: "minor", issue: "naming nit" }] },
    });
    const trace = await recordFeatureTrace("quality-floor", h);
    // AC-34: the reviewer's verdict left nothing blocking, so the machine supplies the target itself.
    const first = h.fixInputs[0];
    assertDefined(first, "the branch fix argument");
    expect(first.map((finding) => finding.issue)).toContain("quality: reviewer reported changes without a finding");
    await compareWithGolden(trace);
  });
});
