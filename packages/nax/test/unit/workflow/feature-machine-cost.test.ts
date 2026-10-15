/** nax#2550: the feature workflow honours `execution.costLimit` — no agent step runs past it. */
import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeFeatureMachineHarness } from "@test/helpers";
import { readinessReasons } from "@/workflow/approval";
import { runFeatureMachine } from "@/workflow/feature-machine";
import type { RepoGateRun } from "@/workflow/repo-gates";
import type { BranchReviewVerdict } from "@/workflow/types";

const { GREEN, PASS } = featureMachineFixtures;
const harness = makeFeatureMachineHarness;

const REVIEW_B1: BranchReviewVerdict = {
  ...PASS,
  spec: "fail",
  findings: [{ kind: "spec", severity: "important", issue: "cap missing", file: "src/a.ts" }],
};
const RED: RepoGateRun = {
  summary: { ran: ["test"], failing: ["test"] },
  findings: [{ kind: "gate", severity: "important", issue: "test red" }],
};
const onceCalled = (call: string) => (calls: readonly string[]) => calls.some((c) => c.startsWith(call));
const always = () => true;

describe("feature workflow cost limit (nax#2550)", () => {
  test("over the limit from the start: repo gates and publish only, no agent step", async () => {
    const h = harness({ review: REVIEW_B1 }, { costExceeded: always });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["repoGates", "publish"]);
    expect(final.costLimited).toBe(true);
    expect(final.reviewRan).toBe(false);
    expect(final.step).toBe("done");
    expect(h.ledger.some((l) => l.includes("cost limit reached: branch-review skipped"))).toBe(true);
  });

  test("crossed after the branch review: no fix, no adjudication, repo gates reused", async () => {
    const h = harness({ review: REVIEW_B1 }, { costExceeded: onceCalled("branchReview") });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["repoGates", "branchReview:seed0", "publish"]);
    expect(final.costLimited).toBe(true);
    expect(final.reviewRan).toBe(true);
    expect(final.fixRan).toBe(false);
    expect(final.finalGates).toEqual(GREEN.summary);
  });

  test("crossed after the branch fix: no re-review or adjudication, final gates still run", async () => {
    const h = harness({ review: REVIEW_B1 }, { costExceeded: onceCalled("branchFix") });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["repoGates", "branchReview:seed0", "branchFix", "repoGates", "publish"]);
    expect(final.costLimited).toBe(true);
    expect(final.finalGates).toEqual(GREEN.summary);
  });

  test("final gates the fix turned red get no repair past the limit", async () => {
    const h = harness({ review: REVIEW_B1, gates: [GREEN, RED] }, { costExceeded: onceCalled("branchFix") });
    const final = await runFeatureMachine(h.env);
    expect(h.calls.filter((c) => c === "branchFix")).toHaveLength(1);
    expect(final.finalGates).toEqual(RED.summary);
    expect(final.gateRepairRounds).toBeUndefined();
    expect(final.step).toBe("done");
  });

  test("a resume parked at gate-repair goes back to the final gates, then publishes", async () => {
    const h = harness(
      { gates: [RED] },
      {
        costExceeded: always,
        record: {
          ...harness({}).env.record,
          step: "gate-repair",
          fixRan: true,
          repoGates: GREEN.summary,
          gateRepairFindings: RED.findings,
        },
      },
    );
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["repoGates", "publish"]);
    expect(final.finalGates).toEqual(RED.summary);
  });

  test("crossed during a clean branch review: nothing left to cut, so no costLimited flag", async () => {
    const h = harness({}, { costExceeded: onceCalled("branchReview") });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toEqual(["repoGates", "branchReview:seed0", "publish"]);
    expect(final.costLimited).toBeUndefined();
    expect(h.ledger.some((l) => l.includes("cost limit reached"))).toBe(false);
  });

  test("under the limit nothing changes and no costLimited flag is written", async () => {
    const h = harness({ review: REVIEW_B1 }, { costExceeded: () => false });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toContain("branchFix");
    expect(final.costLimited).toBeUndefined();
  });

  test("a cost-limited record is a readiness reason", () => {
    expect(
      readinessReasons({
        finalGates: GREEN.summary,
        ci: "green",
        stories: [],
        flagged: 0,
        branchReviewRan: true,
        costLimited: true,
      }),
    ).toEqual(["cost limit reached: the feature workflow stopped before its review and fix steps finished"]);
  });
});
