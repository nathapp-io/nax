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
const PASS: BranchReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
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
  fix?: BranchFixOutcome;
}

function harness(
  script: Script,
  over: { record?: WorkflowFeatureRecord; stories?: StorySummary[]; aborted?: boolean } = {},
) {
  const calls: string[] = [];
  const ledger: string[] = [];
  const stepsSeen: FeatureStep[] = [];
  const updates: WorkflowFeatureRecord[] = [];
  const fixInputs: (readonly WorkflowFinding[])[] = [];
  const reReviewInputs: (readonly WorkflowFinding[])[] = [];
  const adjudicated: (readonly WorkflowFinding[])[] = [];
  const gates = [...(script.gates ?? [])];
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
      const v =
        script.reReview === undefined
          ? { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] }
          : script.reReview;
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
    },
    facts: { stories: over.stories ?? [done("US-001")], parked: [], cannotVerify: [] },
    record: over.record ?? newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
    aborted: () => over.aborted === true,
    now: () => (clock += 5),
  };
  return { env, calls, ledger, stepsSeen, updates, fixInputs, reReviewInputs, adjudicated };
}

describe("runFeatureMachine", () => {
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
});
