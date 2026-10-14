import { describe, expect, test } from "bun:test";
import type { BranchFixOutcome } from "@/workflow/branch-fix";
import { type FeatureEnv, type FeatureSteps, runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { PublishOutcome } from "@/workflow/finalize";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type {
  BranchReviewVerdict,
  FeatureStep,
  ReReviewVerdict,
  StorySummary,
  WorkflowFeatureRecord,
  WorkflowFinding,
} from "@/workflow/types";

const GREEN: RepoGateRun = { summary: { ran: ["build", "test"], failing: [] }, findings: [] };
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
const PASS: BranchReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};
const FIXED: BranchFixOutcome = {
  reply: { status: "DONE", commits: [], testSummary: "", interrupted: false },
  autoCommitted: false,
  dirty: false,
};
const PUBLISHED: PublishOutcome = { outcome: "ready", ci: "pending", url: "https://gh/pr/1", reasons: [] };
const done = (id: string, over: Partial<StorySummary> = {}): StorySummary => ({
  id,
  title: id,
  state: "complete",
  rounds: 0,
  unreviewed: false,
  flagged: 0,
  ...over,
});

interface Script {
  gates?: RepoGateRun[];
  review?: BranchReviewVerdict | null;
  reReview?: ReReviewVerdict | null;
  reReviews?: (ReReviewVerdict | null)[];
  changed?: string[] | Error;
  fix?: BranchFixOutcome;
}

function harness(
  script: Script,
  over: { record?: WorkflowFeatureRecord; stories?: StorySummary[]; aborted?: boolean } = {},
) {
  const calls: string[] = [];
  const ledger: string[] = [];
  const artifacts: Record<string, unknown> = {};
  const stepsSeen: FeatureStep[] = [];
  const updates: WorkflowFeatureRecord[] = [];
  const fixInputs: (readonly WorkflowFinding[])[] = [];
  const reReviewInputs: (readonly WorkflowFinding[])[] = [];
  const adjudicated: (readonly WorkflowFinding[])[] = [];
  const gates = [...(script.gates ?? [])];
  const reReviewQueue = [...(script.reReviews ?? [])];
  let clock = 0;
  const steps: FeatureSteps = {
    repoGates: async () => {
      calls.push("repoGates");
      return gates.shift() ?? GREEN;
    },
    branchReview: async (seed) => {
      calls.push(`branchReview:${seed}`);
      const v = script.review === undefined ? PASS : script.review;
      return v === null ? { ran: false, why: "unparseable reply" } : { ran: true, verdict: v };
    },
    branchFix: async (findings) => {
      calls.push("branchFix");
      fixInputs.push(findings);
      return script.fix ?? FIXED;
    },
    branchReReview: async (findings, fixBase) => {
      calls.push(`branchReReview:${fixBase}`);
      reReviewInputs.push(findings);
      const queued = reReviewQueue.length > 0 ? reReviewQueue.shift() : undefined;
      const fallback = script.reReview;
      const v =
        queued !== undefined
          ? queued
          : fallback === undefined
            ? { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] }
            : fallback;
      return v === null ? { ran: false, why: "timeout" } : { ran: true, verdict: v };
    },
    adjudicate: async (items) => {
      calls.push("adjudicate");
      adjudicated.push(items);
      return items.map((f) => ({
        findingId: f.id,
        action: "hold" as const,
        text: `hold ${f.id}`,
        why: "w",
        costIfWrong: "c",
        source: "default" as const,
      }));
    },
    publish: async () => {
      calls.push("publish");
      return PUBLISHED;
    },
    head: async () => `h${calls.length}`,
    changedFiles: async () => {
      calls.push("changedFiles");
      if (script.changed instanceof Error) throw script.changed;
      return script.changed ?? [];
    },
  };
  const env: FeatureEnv = {
    steps,
    sink: {
      update: async (r) => {
        updates.push(r);
      },
      ledger: async (t) => {
        ledger.push(t);
      },
      step: (s) => {
        stepsSeen.push(s);
      },
      artifact: async (name, value) => {
        artifacts[name] = value;
      },
    },
    facts: { stories: over.stories ?? [done("US-001")], parked: [], cannotVerify: [] },
    record: over.record ?? newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
    aborted: () => over.aborted === true,
    now: () => (clock += 5),
  };
  return { env, calls, ledger, artifacts, stepsSeen, updates, fixInputs, reReviewInputs, adjudicated };
}

describe("runFeatureMachine", () => {
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

const REVIEW_B1: BranchReviewVerdict = {
  ...PASS,
  spec: "fail",
  findings: [{ kind: "spec", severity: "important", issue: "cap missing", file: "src/a.ts" }],
};
const NEW_IN_FIX = (file?: string): ReReviewVerdict => ({
  verdicts: [{ id: "B1", addressed: true, note: "" }],
  newFindings: [{ kind: "spec", severity: "important", issue: "fix broke publish", ...(file ? { file } : {}) }],
});
const ALL_ADDRESSED = (id: string): ReReviewVerdict => ({
  verdicts: [{ id, addressed: true, note: "" }],
  newFindings: [],
});

describe("second branch fix (#2496)", () => {
  test("taken when every item is addressed and new blocking findings sit in the fix diff", async () => {
    const h = harness({
      review: REVIEW_B1,
      reReviews: [NEW_IN_FIX("src/a.ts"), ALL_ADDRESSED("B2")],
      changed: ["src/a.ts"],
    });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs.map((f) => f.map((x) => x.id))).toEqual([["B1"], ["B2"]]);
    expect(h.reReviewInputs[1]?.map((f) => f.id)).toEqual(["B2"]);
    expect(final.fixRounds).toBe(2);
    expect(final.reviewOpen).toEqual([]);
    expect(h.calls).not.toContain("adjudicate");
    expect(h.ledger.some((l) => l.startsWith("branch fix r2: 1 item(s): B2"))).toBe(true);
    expect(h.artifacts["branch-rereview-r2.json"]).toBeDefined();
  });

  test("never a third round: round-2 re-review findings go to adjudicate", async () => {
    const h = harness({
      review: REVIEW_B1,
      reReviews: [NEW_IN_FIX("src/a.ts"), NEW_IN_FIX("src/a.ts")],
      changed: ["src/a.ts"],
    });
    const final = await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(2);
    expect(h.calls).toContain("adjudicate");
    expect(final.fixRounds).toBe(2);
  });

  test("not taken when an earlier item stays open", async () => {
    const stillOpen: ReReviewVerdict = {
      ...NEW_IN_FIX("src/a.ts"),
      verdicts: [{ id: "B1", addressed: false, note: "" }],
    };
    const h = harness({ review: REVIEW_B1, reReviews: [stillOpen], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(h.calls).toContain("adjudicate");
  });

  test("not taken when a new finding is outside the fix diff", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("src/other.ts")], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
  });

  test("not taken when a new finding names no file", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX()], changed: ["src/a.ts"] });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
  });

  test("a git failure listing the fix diff skips the second fix and says so", async () => {
    const h = harness({ review: REVIEW_B1, reReviews: [NEW_IN_FIX("src/a.ts")], changed: new Error("bad revision") });
    await runFeatureMachine(h.env);
    expect(h.fixInputs).toHaveLength(1);
    expect(h.ledger.some((l) => l.includes("second branch fix skipped"))).toBe(true);
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
    const h = harness({ review: SAME_PLACE_B1, reReview: verdict });
    const final = await runFeatureMachine(h.env);
    // B1 is still open, so #2496's second fix is not eligible: the new finding goes to adjudication too.
    expect(final.reviewOpen.map((f) => f.id)).toEqual(["B1", "B2"]);
    expect(final.reviewOpen.map((f) => f.issue)).toEqual(["symlinks still bypass", "broke publish"]);
    expect(h.adjudicated[0]?.map((f) => f.id)).toEqual(["B1", "B2"]);
    expect(h.fixInputs).toHaveLength(1);
  });
});
