/** nax#2550: what the feature machine records so a skipped or empty review is never read as a clean one. */
import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeFeatureMachineHarness } from "@test/helpers";
import { runFeatureMachine } from "@/workflow/feature-machine";
import type { BranchReviewVerdict } from "@/workflow/types";

const { PASS } = featureMachineFixtures;
const harness = makeFeatureMachineHarness;

const ONE_FINDING: BranchReviewVerdict = {
  ...PASS,
  findings: [{ kind: "spec", severity: "important", issue: "AC-2 unwired" }],
};

describe("skipped branch re-review (nax#2550)", () => {
  test("a re-review that did not run is recorded on the feature record", async () => {
    const h = harness({ review: ONE_FINDING, reReview: null });
    const final = await runFeatureMachine(h.env);
    expect(final.fixRan).toBe(true);
    expect(final.reReviewSkipped).toBe(true);
  });

  test("a re-review that ran leaves the record without the flag", async () => {
    const h = harness({ review: ONE_FINDING });
    const final = await runFeatureMachine(h.env);
    expect(final).not.toHaveProperty("reReviewSkipped");
  });

  test("a clean branch (no fix, no re-review needed) is not flagged", async () => {
    const final = await runFeatureMachine(harness({}).env);
    expect(final).not.toHaveProperty("reReviewSkipped");
  });
});

describe("branch review quality: changes without a finding (nax#2550)", () => {
  test("is not clean: a synthetic blocking quality finding is opened and fixed", async () => {
    const h = harness({ review: { ...PASS, quality: "changes" } });
    const final = await runFeatureMachine(h.env);
    expect(h.calls).toContain("branchFix");
    expect(h.fixInputs[0]?.map((f) => f.issue)).toEqual(["quality: reviewer reported changes without a finding"]);
    expect(h.fixInputs[0]?.[0]).toMatchObject({ id: "B1", kind: "quality", severity: "important" });
    expect(final.nextFindingId).toBe(2);
  });

  test("a blocking finding already present adds no synthetic one", async () => {
    const h = harness({ review: { ...ONE_FINDING, quality: "changes" } });
    await runFeatureMachine(h.env);
    expect(h.fixInputs[0]?.map((f) => f.id)).toEqual(["B1"]);
  });

  test("approved quality with no findings stays clean", async () => {
    const h = harness({});
    await runFeatureMachine(h.env);
    expect(h.calls).not.toContain("branchFix");
  });
});

describe("lastHead (nax#2550)", () => {
  test("is refreshed after each step that can commit, from steps.head()", async () => {
    const h = harness({ review: ONE_FINDING });
    const final = await runFeatureMachine(h.env);
    const afterFix = h.updates.find((u) => u.step === "branch-rereview");
    expect(afterFix?.lastHead).toMatch(/^h\d+$/);
    expect(final.lastHead).toBeDefined();
  });

  test("a failed read leaves it unset, falling back to startHead", async () => {
    const h = harness({});
    const env = {
      ...h.env,
      steps: {
        ...h.env.steps,
        head: async () => {
          throw new Error("rev-parse failed");
        },
      },
    };
    // A record resumed at gate-repair (no findings: no fix base read) runs a committing step.
    const record = { ...h.env.record, lastHead: "stale", step: "gate-repair" as const };
    const final = await runFeatureMachine({ ...env, record });
    expect(final.step).toBe("done");
    expect(final.lastHead).toBeUndefined();
  });
});

describe("HEAD reads (nax#2550)", () => {
  test("a HEAD that cannot be read after publish keeps the outcome and records no head", async () => {
    const h = harness({});
    const env = {
      ...h.env,
      steps: {
        ...h.env.steps,
        head: async () => {
          throw new Error("rev-parse failed");
        },
      },
    };
    const final = await runFeatureMachine(env);
    expect(final.step).toBe("done");
    expect(final.outcome).toBe("ready");
    expect(final).not.toHaveProperty("head");
  });

  test("a HEAD that cannot be read for the fix base stops the machine rather than fixing with no base", async () => {
    const h = harness({ review: ONE_FINDING });
    const env = {
      ...h.env,
      steps: {
        ...h.env.steps,
        head: async () => {
          throw new Error("rev-parse failed");
        },
      },
    };
    await expect(runFeatureMachine(env)).rejects.toThrow("rev-parse failed");
    expect(h.calls).not.toContain("branchFix");
  });
});
