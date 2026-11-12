/**
 * US-004: a gate repair's committed diff gets one evidence-only re-review.
 *
 * `gateRepairStep` reads HEAD around its repair session and, when the repair moved it, asks
 * `steps.repairReview` for one verdict over the repair diff. The verdict is a record line in
 * `repairReviews` and nothing else: it opens no fix round, and the repair session runs exactly as it
 * did before whatever the HEAD reads return.
 *
 * The lines and the skip cases belong to `reviewRepairDiff`, so they are pinned through the step
 * that calls it — the same way `feature-steps-repair-routing.test.ts` pins what a step forwards.
 */
import { describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import type { BranchFixOutcome } from "@/workflow/branch-fix";
import type { FeatureLimits } from "@/workflow/branch-fix-rounds";
import { newFeatureRecord } from "@/workflow/feature-record";
import * as featureSteps from "@/workflow/feature-steps";
import { reviewRepairDiff } from "@/workflow/repair-review";
import type { ReviewOutcome } from "@/workflow/story-review";
import type { ReReviewVerdict, WorkflowFeatureRecord, WorkflowFinding, WorkflowFindingDraft } from "@/workflow/types";

/** One red gate, as the final gates turn it into the gate repair's finding. */
const GATE_CHECK: WorkflowFindingDraft = { kind: "gate", severity: "important", issue: "repo gate test failed: FAIL" };
const G1: WorkflowFinding = { ...GATE_CHECK, id: "G1" };
const FIXED: BranchFixOutcome = { autoCommitted: true, dirty: false };
const SESSION_FAILED: BranchFixOutcome = { failure: "timeout", autoCommitted: false, dirty: false };
const LIMITS: FeatureLimits = { maxBranchFixRounds: 2, finalGateRepairRounds: 1, ciRepairRounds: 1 };

const ran = (verdict: ReReviewVerdict): ReviewOutcome<ReReviewVerdict> => ({ ran: true, verdict });

/** One verdict entry: addressed, unless the test says otherwise. */
const entry = (
  id: string,
  over: Partial<ReReviewVerdict["verdicts"][number]> = {},
): ReReviewVerdict["verdicts"][number] => ({ id, addressed: true, note: "", ...over });

/** The plain answer: G1 addressed and nothing new. */
const ADDRESSED = ran({ verdicts: [entry("G1")], newFindings: [] });

interface HarnessOpts {
  readonly record?: Partial<WorkflowFeatureRecord>;
  /** The HEAD shas the reads resolve, in order; an `Error` rejects that read. The last one repeats. */
  readonly heads?: readonly (string | Error)[];
  readonly review?: ReviewOutcome<ReReviewVerdict> | Error;
  readonly fix?: BranchFixOutcome;
  readonly limits?: FeatureLimits;
  /** `false` leaves `steps.repairReview` unset, as a run that wires no repair review has it. */
  readonly wired?: boolean;
  /** The run's cost check, read at the moment the review would dispatch; absent = never exceeded. */
  readonly cost?: (calls: readonly string[]) => boolean;
}

function harness(opts: HarnessOpts = {}) {
  const base = makeFeatureMachineHarness(
    { fix: opts.fix ?? FIXED },
    {
      limits: opts.limits ?? LIMITS,
      ...(opts.cost ? { costExceeded: opts.cost } : {}),
      record: {
        ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
        gateRepairFindings: [GATE_CHECK],
        ...opts.record,
      },
    },
  );
  const heads = [...(opts.heads ?? ["h1", "h2"])];
  const reviews: { findings: readonly WorkflowFinding[]; base: string }[] = [];
  let fixes = 0;
  let reads = 0;
  const steps = {
    ...base.env.steps,
    head: async (): Promise<string> => {
      reads += 1;
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
    reads: () => reads,
    patch: async () => (await featureSteps.gateRepairStep(env, env.record)).patch,
  };
}

describe("the gate repair's review of its own diff (US-004)", () => {
  test("AC-1: a moved HEAD reviews the repair diff against the HEAD it started from", async () => {
    const h = harness();
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([{ findings: [G1], base: "h1" }]);
  });

  test("AC-2: an addressed finding is one `reviewed` line", async () => {
    const h = harness({ review: ADDRESSED });
    expect(await h.patch()).toHaveProperty("repairReviews", ["gate repair r1 reviewed: G1 addressed"]);
  });

  test("AC-3: a finding still open names the new finding with its file", async () => {
    const h = harness({
      review: ran({
        verdicts: [entry("G1", { addressed: false })],
        newFindings: [{ kind: "quality", severity: "important", issue: "leaks a handle", file: "src/a.ts" }],
      }),
    });
    expect(await h.patch()).toHaveProperty("repairReviews", [
      "gate repair r1 reviewed: G1 NOT addressed; new: [important] src/a.ts: leaks a handle",
    ]);
  });

  test("AC-4: a new finding with no file is named by its severity and issue", async () => {
    const h = harness({
      review: ran({
        verdicts: [entry("G1")],
        newFindings: [{ kind: "quality", severity: "minor", issue: "naming" }],
      }),
    });
    expect(await h.patch()).toHaveProperty("repairReviews", [
      "gate repair r1 reviewed: G1 addressed; new: [minor] naming",
    ]);
  });

  test("AC-5: a residual reads PARTIAL", async () => {
    const h = harness({
      review: ran({
        verdicts: [entry("G1", { addressed: false, residual: { issue: "still leaks on the error path" } })],
        newFindings: [],
      }),
    });
    expect(await h.patch()).toHaveProperty("repairReviews", ["gate repair r1 reviewed: G1 PARTIAL"]);
  });

  test.each(["timeout", "unparseable reply (not reviewable)"])(
    "AC-6: a review that did not run records its own why verbatim (%s)",
    async (why) => {
      const h = harness({ review: { ran: false, why } });
      expect(await h.patch()).toHaveProperty("repairReviews", [`gate repair r1 review skipped: ${why}`]);
    },
  );

  test("AC-7: an unmoved HEAD reviews nothing", async () => {
    const h = harness({ heads: ["h1", "h1"] });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([]);
  });

  test("AC-8: an unmoved HEAD adds no repairReviews key", async () => {
    const h = harness({ heads: ["h1", "h1"] });
    expect("repairReviews" in (await h.patch())).toBe(false);
  });

  test("AC-9: a failed repair session is not reviewed", async () => {
    const h = harness({ fix: SESSION_FAILED });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([]);
  });

  test("AC-10: an unreadable HEAD still runs the repair, once", async () => {
    const h = harness({ heads: [new Error("git rev-parse failed")] });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.fixes()).toBe(1);
  });

  test("AC-11: an unreadable HEAD before the repair reviews nothing", async () => {
    const h = harness({ heads: [new Error("git rev-parse failed")] });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([]);
  });

  test("AC-12: an unreadable HEAD before the repair says so in the ledger", async () => {
    const h = harness({ heads: [new Error("git rev-parse failed")] });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("gate repair r1 review skipped: could not read HEAD");
  });

  // F1: the note is about the read, not about the session — a failed repair reports both.
  test("AC-12: an unreadable HEAD before the repair still says so when the repair session fails too", async () => {
    const h = harness({ heads: [new Error("git rev-parse failed")], fix: SESSION_FAILED });
    const patch = await h.patch();
    expect(h.ledger).toContain("gate repair r1 review skipped: could not read HEAD");
    expect(patch).toHaveProperty("gateRepairRounds", 1);
    expect("repairReviews" in patch).toBe(false);
  });

  test("AC-13: a HEAD read that fails after the repair reviews nothing", async () => {
    const h = harness({ heads: ["h1", new Error("git rev-parse failed")] });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.reviews).toEqual([]);
  });

  test("AC-19: a HEAD read that fails after the repair says so in the ledger", async () => {
    const h = harness({ heads: ["h1", new Error("git rev-parse failed")] });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("gate repair r1 review skipped: could not read HEAD");
  });

  test.each([
    ["before", [new Error("git rev-parse failed")]],
    ["after", ["h1", new Error("git rev-parse failed")]],
  ] as const)("AC-20: a HEAD read that throws %s the repair keeps its spent round", async (_when, heads) => {
    const h = harness({ heads });
    expect(await h.patch()).toHaveProperty("gateRepairRounds", 1);
  });

  test("AC-14: a second round appends its line after the first", async () => {
    const first = "gate repair r1 reviewed: G1 addressed";
    const h = harness({
      record: { gateRepairRounds: 1, repairReviews: [first] },
      limits: { ...LIMITS, finalGateRepairRounds: 2 },
    });
    expect(await h.patch()).toHaveProperty("repairReviews", [first, "gate repair r2 reviewed: G1 addressed"]);
  });

  test("AC-15: a run that wires no repair review never reads HEAD", async () => {
    const h = harness({ wired: false });
    await featureSteps.gateRepairStep(h.env, h.env.record);
    expect(h.reads()).toBe(0);
  });

  test("AC-16: a run that wires no repair review adds no repairReviews key", async () => {
    const h = harness({ wired: false });
    expect("repairReviews" in (await h.patch())).toBe(false);
  });

  test("AC-18: a failed repair session adds no repairReviews key", async () => {
    const h = harness({ fix: SESSION_FAILED });
    expect("repairReviews" in (await h.patch())).toBe(false);
  });

  test("a review that throws records itself as skipped and keeps the repair", async () => {
    const h = harness({ review: new Error("review op exploded") });
    expect(await h.patch()).toHaveProperty("repairReviews", ["gate repair r1 review skipped: review op exploded"]);
  });

  // B1: the graph reads the cost limit before the repair node; the repair can be what exhausts it.
  test("B1: a repair that spends the last of the budget dispatches no review", async () => {
    const h = harness({ cost: (calls) => calls.includes("branchFix") });
    expect(await h.patch()).toHaveProperty("repairReviews", ["gate repair r1 review skipped: cost limit reached"]);
    expect(h.reviews).toEqual([]);
  });

  test("B1: an exhausted budget still runs the repair and keeps its outcome", async () => {
    const h = harness({ cost: () => true });
    const patch = await h.patch();
    expect(h.fixes()).toBe(1);
    expect(patch).toHaveProperty("gateRepairRounds", 1);
    expect(patch).toHaveProperty("repairReviews", ["gate repair r1 review skipped: cost limit reached"]);
    expect(h.reviews).toEqual([]);
  });
});

describe("reviewRepairDiff with no finding to review against (US-004)", () => {
  test("runs the repair, reads no HEAD and adds no line", async () => {
    const h = harness();
    const outcome: BranchFixOutcome = { autoCommitted: false, dirty: false };
    let fixes = 0;
    const result = await reviewRepairDiff(h.env, {
      kind: "gate repair",
      round: 1,
      findings: [],
      history: [],
      run: async () => {
        fixes += 1;
        return outcome;
      },
    });
    expect(result).toEqual({ outcome, patch: {} });
    expect(fixes).toBe(1);
    expect(h.reads()).toBe(0);
    expect(h.reviews).toEqual([]);
  });
});
