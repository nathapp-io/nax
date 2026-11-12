/**
 * US-005: a CI repair's committed diff gets the same evidence-only re-review the gate repair's does.
 *
 * `ciRepairStep` reads HEAD around its repair session and, when the repair moved it, asks
 * `steps.repairReview` for one verdict over the repair diff. The verdict is a record line in
 * `repairReviews` and nothing else: it opens no fix round, and the repair session runs exactly as it
 * did before whatever the HEAD reads return.
 *
 * The lines and the skip cases belong to US-004's `reviewRepairDiff`, so they are pinned through the
 * step that calls it — the same way `repair-review.test.ts` pins the gate repair.
 */
import { describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import type { BranchFixOutcome } from "@/workflow/branch-fix";
import type { FeatureLimits } from "@/workflow/branch-fix-rounds";
import { ciRepairStep } from "@/workflow/ci-repair-steps";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { ReviewOutcome } from "@/workflow/story-review";
import type { ReReviewVerdict, WorkflowFeatureRecord, WorkflowFinding, WorkflowFindingDraft } from "@/workflow/types";

/** The limits of a run that may repair CI twice. */
const LIMITS: FeatureLimits = { maxBranchFixRounds: 2, finalGateRepairRounds: 1, ciRepairRounds: 2 };

/** The one failed check the publish step turned into the CI repair's finding. */
const CI_CHECK: WorkflowFindingDraft = { kind: "gate", severity: "important", issue: "CI check e2e failed:\nboom" };
const C1: WorkflowFinding = { ...CI_CHECK, id: "C1" };
const FIXED: BranchFixOutcome = { autoCommitted: true, dirty: false };
const SESSION_FAILED: BranchFixOutcome = { failure: "timeout", autoCommitted: false, dirty: false };

const ran = (verdict: ReReviewVerdict): ReviewOutcome<ReReviewVerdict> => ({ ran: true, verdict });

/** One verdict entry: addressed, unless the test says otherwise. */
const entry = (
  id: string,
  over: Partial<ReReviewVerdict["verdicts"][number]> = {},
): ReReviewVerdict["verdicts"][number] => ({ id, addressed: true, note: "", ...over });

/** The plain answer: C1 addressed and nothing new. */
const ADDRESSED = ran({ verdicts: [entry("C1")], newFindings: [] });

interface HarnessOpts {
  readonly record?: Partial<WorkflowFeatureRecord>;
  /** The HEAD shas the reads resolve, in order; an `Error` rejects that read. The last one repeats. */
  readonly heads?: readonly (string | Error)[];
  readonly review?: ReviewOutcome<ReReviewVerdict> | Error;
  readonly fix?: BranchFixOutcome;
  readonly wired?: boolean;
  /** The run's cost check, read at the moment the review would dispatch; absent = never exceeded. */
  readonly cost?: (calls: readonly string[]) => boolean;
}

function harness(opts: HarnessOpts = {}) {
  const base = makeFeatureMachineHarness(
    { fix: opts.fix ?? FIXED },
    {
      limits: LIMITS,
      ...(opts.cost ? { costExceeded: opts.cost } : {}),
      record: {
        ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
        ciRepairFindings: [CI_CHECK],
        ...opts.record,
      },
    },
  );
  const heads = [...(opts.heads ?? ["h1", "h2"])];
  const reviews: { findings: readonly WorkflowFinding[]; base: string }[] = [];
  let fixes = 0;
  const steps = {
    ...base.env.steps,
    head: async (): Promise<string> => {
      const next = heads.length > 1 ? heads.shift() : heads[0];
      if (next instanceof Error) throw next;
      return next ?? "h1";
    },
    branchFix: async (...args: Parameters<typeof base.env.steps.branchFix>) => {
      fixes += 1;
      return base.env.steps.branchFix(...args);
    },
    ...(opts.wired === false
      ? {}
      : {
          repairReview: async (findings: readonly WorkflowFinding[], at: string) => {
            reviews.push({ findings, base: at });
            const answer = opts.review ?? ADDRESSED;
            if (answer instanceof Error) throw answer;
            return answer;
          },
        }),
  };
  const env = { ...base.env, steps };
  return {
    env,
    reviews,
    ledger: base.ledger,
    fixes: () => fixes,
    patch: async () => (await ciRepairStep(env, env.record)).patch,
  };
}

describe("the CI repair's review of its own diff (US-005)", () => {
  test("AC-1: a moved HEAD reviews the repair diff against the HEAD it started from", async () => {
    const h = harness();
    await ciRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([{ findings: [C1], base: "h1" }]);
  });

  test("AC-2: an addressed finding is one `reviewed` line", async () => {
    const h = harness({ review: ADDRESSED });
    expect(await h.patch()).toHaveProperty("repairReviews", ["CI repair r1 reviewed: C1 addressed"]);
  });

  test("AC-3: a HEAD read that fails before the repair still runs the repair, once", async () => {
    const h = harness({ heads: [new Error("git rev-parse failed")] });
    await ciRepairStep(h.env, h.env.record);
    expect(h.fixes()).toBe(1);
  });

  test("AC-4: a HEAD read that fails before the repair says so in the ledger", async () => {
    const h = harness({ heads: [new Error("git rev-parse failed")] });
    await ciRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("CI repair r1 review skipped: could not read HEAD");
  });

  test("AC-5: a run that wires no repair review adds no repairReviews key", async () => {
    const h = harness({ wired: false });
    expect("repairReviews" in (await h.patch())).toBe(false);
  });

  test("AC-7: a failed repair session is not reviewed", async () => {
    const h = harness({ fix: SESSION_FAILED });
    await ciRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([]);
  });

  test("AC-8: a failed repair session adds no repairReviews key", async () => {
    const h = harness({ fix: SESSION_FAILED });
    expect("repairReviews" in (await h.patch())).toBe(false);
  });

  test("AC-9: an unmoved HEAD reviews nothing", async () => {
    const h = harness({ heads: ["h1", "h1"] });
    await ciRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([]);
  });

  test("AC-10: an unmoved HEAD adds no repairReviews key", async () => {
    const h = harness({ heads: ["h1", "h1"] });
    expect("repairReviews" in (await h.patch())).toBe(false);
  });

  test("AC-11: an unreadable HEAD before the repair reviews nothing", async () => {
    const h = harness({ heads: [new Error("git rev-parse failed")] });
    await ciRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([]);
  });

  test("AC-12: a HEAD read that fails after the repair reviews nothing", async () => {
    const h = harness({ heads: ["h1", new Error("git rev-parse failed")] });
    await ciRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([]);
  });

  test("AC-13: a HEAD read that fails after the repair says so in the ledger", async () => {
    const h = harness({ heads: ["h1", new Error("git rev-parse failed")] });
    await ciRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("CI repair r1 review skipped: could not read HEAD");
  });

  test.each([
    ["before", [new Error("git rev-parse failed")]],
    ["after", ["h1", new Error("git rev-parse failed")]],
  ] as const)("AC-14: a HEAD read that throws %s the repair keeps its spent round", async (_when, heads) => {
    const h = harness({ heads });
    expect(await h.patch()).toHaveProperty("ciRepairRounds", 1);
  });

  test("AC-15: a review that did not run records its own why verbatim", async () => {
    const h = harness({ review: { ran: false, why: "unparseable reply" } });
    expect(await h.patch()).toHaveProperty("repairReviews", ["CI repair r1 review skipped: unparseable reply"]);
  });

  test("a second round appends its line after the first", async () => {
    const first = "CI repair r1 reviewed: C1 addressed";
    const h = harness({ record: { ciRepairRounds: 1, repairReviews: [first] } });
    expect(await h.patch()).toHaveProperty("repairReviews", [first, "CI repair r2 reviewed: C1 addressed"]);
  });

  test("a run that wires no repair review still runs the repair", async () => {
    const h = harness({ wired: false });
    await h.patch();
    expect(h.fixes()).toBe(1);
  });

  test("a review that throws records itself as skipped and keeps the repair", async () => {
    const h = harness({ review: new Error("review op exploded") });
    expect(await h.patch()).toHaveProperty("repairReviews", ["CI repair r1 review skipped: review op exploded"]);
    expect(h.fixes()).toBe(1);
  });

  // B1: the graph reads the cost limit before the repair node; the repair can be what exhausts it.
  test("B1: a CI repair that spends the last of the budget dispatches no review", async () => {
    const h = harness({ cost: (calls) => calls.includes("branchFix") });
    expect(await h.patch()).toHaveProperty("repairReviews", ["CI repair r1 review skipped: cost limit reached"]);
    expect(h.reviews).toEqual([]);
  });

  test("B1: an exhausted budget still runs the CI repair and keeps its outcome", async () => {
    const h = harness({ cost: () => true });
    const patch = await h.patch();
    expect(h.fixes()).toBe(1);
    expect(patch).toHaveProperty("ciRepairRounds", 1);
    expect(patch).toHaveProperty("repairReviews", ["CI repair r1 review skipped: cost limit reached"]);
    expect(h.reviews).toEqual([]);
  });
});
