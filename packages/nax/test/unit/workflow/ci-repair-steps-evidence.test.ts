/**
 * US-005: the CI repair's evidence — the checks a repair round targeted and the concerns its
 * replies raised.
 *
 * A repair reply may carry `concerns` (a check it could not run, for instance). Nothing read them,
 * so a half-done repair looked like a done one. The step now appends them to a round-labelled
 * history and names them in the ledger; the publish step records which check it decided to repair,
 * from the same single read that produced the repair findings.
 */
import { describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import type { FailedCheck } from "@/forge";
import type { BranchFixOutcome } from "@/workflow/branch-fix";
import type { FeatureLimits } from "@/workflow/branch-fix-rounds";
import { ciRepairStep } from "@/workflow/ci-repair-steps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { publishStep } from "@/workflow/feature-steps";
import type { PublishOutcome } from "@/workflow/finalize";
import type { WorkflowFeatureRecord, WorkflowFindingDraft } from "@/workflow/types";

/** The limits of a run that may repair CI once. */
const LIMITS: FeatureLimits = { maxBranchFixRounds: 2, finalGateRepairRounds: 1, ciRepairRounds: 1 };

const PR_URL = "https://github.com/o/r/pull/7";
const DRAFT_FAILED: PublishOutcome = { outcome: "draft", ci: "failed", url: PR_URL, reasons: ["CI failed"] };
const READY_GREEN: PublishOutcome = { outcome: "ready", ci: "green", url: PR_URL, reasons: [] };

/** The one finding the publish step hands the repair node. */
const FINDING: WorkflowFindingDraft = { kind: "gate", severity: "important", issue: "CI check e2e failed:\nboom" };

const baseRecord = (): WorkflowFeatureRecord => newFeatureRecord({ now: "t", seed: "seed0", minors: [] });

/** A repair reply; `concerns` is omitted entirely when the caller passes nothing. */
const repairReply = (concerns?: string) => ({
  status: "DONE_WITH_CONCERNS" as const,
  commits: [],
  testSummary: "",
  interrupted: false,
  ...(concerns !== undefined ? { concerns } : {}),
});

/** The repair session's outcome for a reply carrying `concerns`. */
const repairOutcome = (concerns?: string): BranchFixOutcome => ({
  reply: repairReply(concerns),
  autoCommitted: false,
  dirty: false,
});

type MachineHarness = ReturnType<typeof makeFeatureMachineHarness>;

interface CiHarness {
  readonly env: MachineHarness["env"];
  /** Every ledger note the step wrote, in order. */
  readonly ledger: readonly string[];
}

/** The shared harness with the repair findings, a round to spend, and the repair session scripted. */
function ciHarness(
  opts: {
    readonly fix?: BranchFixOutcome;
    readonly record?: Partial<WorkflowFeatureRecord>;
    readonly limit?: number;
  } = {},
): CiHarness {
  const base = makeFeatureMachineHarness(opts.fix ? { fix: opts.fix } : {}, {
    limits: { ...LIMITS, ciRepairRounds: opts.limit ?? 1 },
    record: { ...baseRecord(), ciRepairFindings: [FINDING], ...opts.record },
  });
  return { env: base.env, ledger: base.ledger };
}

/** One CI repair round: what the step returned, and every ledger note it wrote. */
interface Round {
  readonly out: Awaited<ReturnType<typeof ciRepairStep>>;
  readonly ledger: readonly string[];
}

/** Run one CI repair round with the repair session scripted by `fix`. */
async function runRound(
  fix: BranchFixOutcome,
  opts: { readonly record?: Partial<WorkflowFeatureRecord>; readonly limit?: number } = {},
): Promise<Round> {
  const h = ciHarness({ fix, ...opts });
  return { out: await ciRepairStep(h.env, h.env.record), ledger: h.ledger };
}

describe("the concerns a CI repair reply raises (US-005)", () => {
  const CONCERNS = "pip-audit not run: PyPI blocked";
  /** The round note every repair round writes, whatever its reply says. */
  const ROUND_NOTE = "CI repair r1: 1 item(s): C1";
  /** The note this round's reply earns, when it carries concerns. */
  const CONCERNS_NOTE = `CI repair r1 concerns: ${CONCERNS}`;

  test("AC-1: the ledger records the round's concerns", async () => {
    expect((await runRound(repairOutcome(CONCERNS))).ledger).toContain(CONCERNS_NOTE);
  });

  test("AC-2: the round's concerns are patched, labelled with the round", async () => {
    expect((await runRound(repairOutcome(CONCERNS))).out.patch.ciRepairConcerns).toEqual([`r1: ${CONCERNS}`]);
  });

  test("AC-3: a later round appends to the history instead of replacing it", async () => {
    const { out } = await runRound(repairOutcome("b"), {
      record: { ciRepairRounds: 1, ciRepairConcerns: ["r1: a"] },
      limit: 2,
    });
    expect(out.patch.ciRepairConcerns).toEqual(["r1: a", "r2: b"]);
    // The round's own note is labelled r2, so the two entries cannot be confused.
    expect(out.patch.ciRepairRounds).toBe(2);
  });

  test("AC-4: empty concerns patch no key at all", async () => {
    const empty = await runRound(repairOutcome(""));
    expect("ciRepairConcerns" in empty.out.patch).toBe(false);
    // The control: the same seams with concerns text do patch one.
    const control = await runRound(repairOutcome(CONCERNS));
    expect(control.out.patch.ciRepairConcerns).toEqual([`r1: ${CONCERNS}`]);
  });

  test("AC-5: empty concerns write no concerns note", async () => {
    // The whole ledger, so the note's absence is not the only thing asserted: the round still ran.
    expect((await runRound(repairOutcome(""))).ledger).toEqual([ROUND_NOTE]);
    // The control: the same seams with concerns text add exactly the note the empty reply omits.
    expect((await runRound(repairOutcome(CONCERNS))).ledger).toEqual([ROUND_NOTE, CONCERNS_NOTE]);
  });

  test("AC-6: a repair session that failed with no reply patches no concerns", async () => {
    const failed = await runRound({ failure: "boom", autoCommitted: false, dirty: false });
    expect("ciRepairConcerns" in failed.out.patch).toBe(false);
    // The premise: the round ran and spent itself.
    expect(failed.out.patch.ciRepairRounds).toBe(1);
    // The control: a failed session whose reply did carry concerns patches them.
    const control = await runRound({
      reply: repairReply(CONCERNS),
      failure: "boom",
      autoCommitted: false,
      dirty: false,
    });
    expect(control.out.patch.ciRepairConcerns).toEqual([`r1: ${CONCERNS}`]);
  });

  test("AC-7: a repair session that failed with no reply writes no concerns note", async () => {
    expect((await runRound({ failure: "boom", autoCommitted: false, dirty: false })).ledger).toEqual([
      ROUND_NOTE,
      "CI repair session failed: boom",
    ]);
    // The control: the same failure with a reply that carries concerns adds the note too.
    expect(
      (
        await runRound({
          reply: repairReply(CONCERNS),
          failure: "boom",
          autoCommitted: false,
          dirty: false,
        })
      ).ledger,
    ).toEqual([ROUND_NOTE, "CI repair session failed: boom", CONCERNS_NOTE]);
  });

  test("AC-8: a reply with no concerns field patches no concerns", async () => {
    const bare = await runRound(repairOutcome());
    expect("ciRepairConcerns" in bare.out.patch).toBe(false);
    // The control: the same reply shape with a concerns field does patch one.
    const control = await runRound(repairOutcome(CONCERNS));
    expect(control.out.patch.ciRepairConcerns).toEqual([`r1: ${CONCERNS}`]);
  });

  test("AC-9: a reply with no concerns field writes no concerns note", async () => {
    expect((await runRound(repairOutcome())).ledger).toEqual([ROUND_NOTE]);
    // The control: the same reply shape with a concerns field adds the note.
    expect((await runRound(repairOutcome(CONCERNS))).ledger).toEqual([ROUND_NOTE, CONCERNS_NOTE]);
  });

  /**
   * AC-4 to AC-9 are absences, which a feature that does not exist also satisfies. This pins the
   * path itself: the step *reads* the reply's `concerns`, so the field — not the reply's mere
   * presence — is what decides. Nothing else in a round's outcome is read this way.
   */
  test("the step reads the reply's concerns, so the field is what decides", async () => {
    let reads = 0;
    const reply = {
      ...repairReply(),
      get concerns(): string {
        reads += 1;
        return "";
      },
    };
    expect((await runRound({ reply, autoCommitted: false, dirty: false })).ledger).toEqual([ROUND_NOTE]);
    expect(reads).toBe(1);
  });

  test("the round is still recorded and the findings still cleared alongside the concerns", async () => {
    const { out } = await runRound(repairOutcome(CONCERNS));
    expect(out.patch.ciRepairRounds).toBe(1);
    expect(out.patch.ciRepairFindings).toBeUndefined();
    // The key is stated, so the record's findings are cleared rather than left behind.
    expect("ciRepairFindings" in out.patch).toBe(true);
  });
});

describe("the checks a decided CI repair targets (US-005)", () => {
  const STEPPED: FailedCheck = { name: "Security audit", failedStep: "bun audit", excerpt: "E" };
  const PLAIN: FailedCheck = { name: "e2e", excerpt: "boom" };

  interface PublishHarness extends CiHarness {
    /** Every CI read the publish step made. */
    readonly reads: readonly { url: string; head: string }[];
  }

  /** The publish step, scripted with the outcome it returns and the failed checks it reads. */
  function publishHarness(opts: {
    readonly checks?: readonly FailedCheck[];
    readonly published?: PublishOutcome;
  }): PublishHarness {
    const base = makeFeatureMachineHarness(
      {
        published: opts.published ?? DRAFT_FAILED,
        ...(opts.checks ? { ciFailures: opts.checks } : {}),
      },
      { limits: LIMITS, record: baseRecord() },
    );
    return { env: base.env, ledger: base.ledger, reads: base.ciFailureInputs };
  }

  test("AC-10: the target names the check and the step that failed", async () => {
    const h = publishHarness({ checks: [STEPPED] });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBe("ci-repair");
    expect(out.patch.ciRepairTargets).toEqual([{ name: "Security audit", failedStep: "bun audit" }]);
  });

  test("AC-11: a check with no failed step carries the name alone", async () => {
    const h = publishHarness({ checks: [PLAIN] });
    const out = await publishStep(h.env, h.env.record);
    expect(out.patch.ciRepairTargets).toEqual([{ name: "e2e" }]);
    // No empty key: the field is absent, not present and undefined.
    expect(out.patch.ciRepairTargets?.[0] ?? {}).not.toHaveProperty("failedStep");
  });

  test("AC-12: a publish that decides no repair patches no targets", async () => {
    const h = publishHarness({ published: READY_GREEN, checks: [STEPPED] });
    const out = await publishStep(h.env, h.env.record);
    expect("ciRepairTargets" in out.patch).toBe(false);
    // The control: the same seams with a failed CI do patch targets.
    const control = publishHarness({ checks: [STEPPED] });
    expect((await publishStep(control.env, control.env.record)).patch.ciRepairTargets).toHaveLength(1);
  });

  test("the targets come from the single read the findings come from", async () => {
    const h = publishHarness({ checks: [STEPPED, PLAIN] });
    const out = await publishStep(h.env, h.env.record);
    expect(h.reads).toHaveLength(1);
    expect(out.patch.ciRepairFindings?.length).toBe(2);
    expect(out.patch.ciRepairTargets).toEqual([{ name: "Security audit", failedStep: "bun audit" }, { name: "e2e" }]);
  });

  test("a read that found no failed check patches no targets", async () => {
    const h = publishHarness({ checks: [], published: DRAFT_FAILED });
    const out = await publishStep(h.env, h.env.record);
    expect("ciRepairTargets" in out.patch).toBe(false);
    // The premise: the read happened, and named no failed check.
    expect(h.reads).toHaveLength(1);
  });
});
