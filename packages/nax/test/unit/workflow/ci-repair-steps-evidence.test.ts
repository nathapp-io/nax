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

/** A fresh CI repair step and record with the given repair outcome, for a control inside a test. */
const withFix = (fix: BranchFixOutcome): [CiHarness["env"], WorkflowFeatureRecord] => {
  const h = ciHarness({ fix });
  return [h.env, h.env.record];
};

/** Whether the step wrote any ledger note starting with `prefix`. */
const wroteNote = (h: CiHarness, prefix: string): boolean => h.ledger.some((text) => text.startsWith(prefix));

describe("the concerns a CI repair reply raises (US-005)", () => {
  const CONCERNS = "pip-audit not run: PyPI blocked";

  test("AC-1: the ledger records the round's concerns", async () => {
    const h = ciHarness({ fix: repairOutcome(CONCERNS) });
    await ciRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain(`CI repair r1 concerns: ${CONCERNS}`);
  });

  test("AC-2: the round's concerns are patched, labelled with the round", async () => {
    const h = ciHarness({ fix: repairOutcome(CONCERNS) });
    const out = await ciRepairStep(h.env, h.env.record);
    expect(out.patch.ciRepairConcerns).toEqual([`r1: ${CONCERNS}`]);
  });

  test("AC-3: a later round appends to the history instead of replacing it", async () => {
    const h = ciHarness({ fix: repairOutcome("b"), record: { ciRepairRounds: 1 }, limit: 2 });
    const out = await ciRepairStep(h.env, { ...h.env.record, ciRepairConcerns: ["r1: a"] });
    expect(out.patch.ciRepairConcerns).toEqual(["r1: a", "r2: b"]);
  });

  test("AC-4: empty concerns patch no key at all", async () => {
    const h = ciHarness({ fix: repairOutcome("") });
    const out = await ciRepairStep(h.env, h.env.record);
    expect("ciRepairConcerns" in out.patch).toBe(false);
    // The control: the same seams with concerns text do patch one.
    const control = await ciRepairStep(...withFix(repairOutcome(CONCERNS)));
    expect(control.patch.ciRepairConcerns).toEqual([`r1: ${CONCERNS}`]);
  });

  test("AC-5: empty concerns write no concerns note", async () => {
    const h = ciHarness({ fix: repairOutcome("") });
    await ciRepairStep(h.env, h.env.record);
    expect(wroteNote(h, "CI repair r1 concerns")).toBe(false);
    // The premise: the repair session ran, and its round note was written.
    expect(wroteNote(h, "CI repair r1: 1 item(s)")).toBe(true);
  });

  test("AC-6: a repair session that failed with no reply patches no concerns", async () => {
    const h = ciHarness({ fix: { failure: "boom", autoCommitted: false, dirty: false } });
    const out = await ciRepairStep(h.env, h.env.record);
    expect("ciRepairConcerns" in out.patch).toBe(false);
    // The premise: the session ran and failed.
    expect(h.ledger).toContain("CI repair session failed: boom");
  });

  test("AC-7: a repair session that failed with no reply writes no concerns note", async () => {
    const h = ciHarness({ fix: { failure: "boom", autoCommitted: false, dirty: false } });
    await ciRepairStep(h.env, h.env.record);
    expect(wroteNote(h, "CI repair r1 concerns")).toBe(false);
    expect(wroteNote(h, "CI repair r1: 1 item(s)")).toBe(true);
  });

  test("AC-8: a reply with no concerns field patches no concerns", async () => {
    const h = ciHarness({ fix: repairOutcome() });
    const out = await ciRepairStep(h.env, h.env.record);
    expect("ciRepairConcerns" in out.patch).toBe(false);
    // The control: the same reply shape with concerns text does patch one.
    const control = await ciRepairStep(...withFix(repairOutcome(CONCERNS)));
    expect(control.patch.ciRepairConcerns).toEqual([`r1: ${CONCERNS}`]);
  });

  test("AC-9: a reply with no concerns field writes no concerns note", async () => {
    const h = ciHarness({ fix: repairOutcome() });
    await ciRepairStep(h.env, h.env.record);
    expect(wroteNote(h, "CI repair r1 concerns")).toBe(false);
    expect(wroteNote(h, "CI repair r1: 1 item(s)")).toBe(true);
  });

  test("the round is still recorded and the findings still cleared alongside the concerns", async () => {
    const h = ciHarness({ fix: repairOutcome(CONCERNS) });
    const out = await ciRepairStep(h.env, h.env.record);
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
