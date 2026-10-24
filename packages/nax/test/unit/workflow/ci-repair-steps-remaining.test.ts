/**
 * US-006: the checks still failing after the last repair round.
 *
 * The repair tokens are spent on the branch fix, and after the last round the ledger said only
 * "CI failed" — no record of which check or step was still red. The publish step now reads the
 * failed checks once more when the rounds are spent, classifies each against the checks the last
 * round targeted, and records them as `ciRemaining`.
 *
 * The read runs no agent, so it happens whatever the cost state; it is also the *only* read a run
 * can make here, because a run with a round to spare reads for the repair decision instead.
 */
import { describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import type { FailedCheck } from "@/forge";
import type { FeatureLimits } from "@/workflow/branch-fix-rounds";
import { newFeatureRecord } from "@/workflow/feature-record";
import { publishStep } from "@/workflow/feature-steps";
import type { PublishOutcome } from "@/workflow/finalize";
import type { CiCheckRef, WorkflowFeatureRecord } from "@/workflow/types";

/** The limits of a run that may repair CI once. */
const LIMITS: FeatureLimits = { maxBranchFixRounds: 2, finalGateRepairRounds: 1, ciRepairRounds: 1 };

/** The limits of a run with no CI repair allowance at all. */
const NO_CI_REPAIR: FeatureLimits = { maxBranchFixRounds: 2, finalGateRepairRounds: 1, ciRepairRounds: 0 };

const PR_URL = "https://github.com/o/r/pull/7";

const DRAFT_FAILED: PublishOutcome = { outcome: "draft", ci: "failed", url: PR_URL, reasons: ["CI failed"] };
const READY_GREEN: PublishOutcome = { outcome: "ready", ci: "green", url: PR_URL, reasons: [] };

/** The check the last repair round targeted: the audit, at the step that failed then. */
const TARGETS: readonly CiCheckRef[] = [{ name: "Security audit", failedStep: "bun audit" }];

/** The same check, now failing at a different step. */
const AT_PIP_AUDIT: FailedCheck = { name: "Security audit", failedStep: "pip-audit", excerpt: "E" };
/** The same check, still failing at the step the last round targeted. */
const AT_BUN_AUDIT: FailedCheck = { name: "Security audit", failedStep: "bun audit", excerpt: "E" };
/** A check the last round never targeted, with no step facts. */
const E2E: FailedCheck = { name: "e2e", excerpt: "boom" };

/** One round spent. */
const SPENT: Partial<WorkflowFeatureRecord> = { ciRepairRounds: 1, ciRepairTargets: TARGETS };

const baseRecord = (): WorkflowFeatureRecord => newFeatureRecord({ now: "t", seed: "seed0", minors: [] });

interface Harness {
  readonly env: ReturnType<typeof makeFeatureMachineHarness>["env"];
  /** Every ledger note the step wrote, in order. */
  readonly ledger: readonly string[];
  /** Every CI read the step made, with what it was asked for. */
  readonly reads: readonly { url: string; head: string }[];
}

interface HarnessOpts {
  /** The failed checks the reader returns; an Error rejects the read. Absent wires no reader. */
  readonly checks?: readonly FailedCheck[] | Error;
  readonly published?: PublishOutcome;
  readonly record?: Partial<WorkflowFeatureRecord>;
  readonly limits?: FeatureLimits;
  /** The run's cost check; absent means the run may spend. */
  readonly costExceeded?: boolean;
}

/** The publish step with the CI reader, the outcome and the record each scenario needs. */
function harness(opts: HarnessOpts = {}): Harness {
  const base = makeFeatureMachineHarness(
    {
      published: opts.published ?? DRAFT_FAILED,
      ...(opts.checks !== undefined ? { ciFailures: opts.checks } : {}),
    },
    {
      limits: opts.limits ?? LIMITS,
      record: { ...baseRecord(), ...opts.record },
      ...(opts.costExceeded ? { costExceeded: () => true } : {}),
    },
  );
  return { env: base.env, ledger: base.ledger, reads: base.ciFailureInputs };
}

/** The publish step's result for these seams. */
async function publish(opts: HarnessOpts = {}) {
  const h = harness(opts);
  return { out: await publishStep(h.env, h.env.record), ledger: h.ledger, reads: h.reads };
}

describe("the checks still failing after the last repair round (US-006)", () => {
  test("AC-1: a check failing at a new step is a new failure", async () => {
    const { out } = await publish({ checks: [AT_PIP_AUDIT], record: SPENT });
    expect(out.patch.ciRemaining).toEqual([{ name: "Security audit", failedStep: "pip-audit", newFailure: true }]);
  });

  test("AC-2: the ledger names the new failure and the step it failed at", async () => {
    const { ledger } = await publish({ checks: [AT_PIP_AUDIT], record: SPENT });
    expect(ledger).toContain(
      'CI still failing after 1 repair round(s): Security audit at step "pip-audit" (new failure)',
    );
  });

  test("AC-3: a spent round schedules no repair", async () => {
    const { out } = await publish({ checks: [AT_PIP_AUDIT], record: SPENT });
    expect(out.exit).toBeUndefined();
    // The premise: the checks were read, for the record rather than for a repair.
    expect(out.patch.ciRepairFindings).toBeUndefined();
  });

  test("AC-4: a check still failing at the targeted step is not a new failure", async () => {
    const { out } = await publish({ checks: [AT_BUN_AUDIT], record: SPENT });
    expect(out.patch.ciRemaining).toEqual([{ name: "Security audit", failedStep: "bun audit", newFailure: false }]);
  });

  test("AC-5: the ledger says a targeted check is still failing", async () => {
    const { ledger } = await publish({ checks: [AT_BUN_AUDIT], record: SPENT });
    expect(ledger).toContain(
      'CI still failing after 1 repair round(s): Security audit at step "bun audit" (still failing)',
    );
  });

  test("AC-6: several checks are classified one by one, in the order the CI named them", async () => {
    const { ledger } = await publish({ checks: [E2E, AT_BUN_AUDIT], record: SPENT });
    expect(ledger).toContain(
      'CI still failing after 1 repair round(s): e2e (new failure); Security audit at step "bun audit" (still failing)',
    );
  });

  test("AC-7: the read runs no agent, so a cost-limited run still reads once", async () => {
    const h = harness({ checks: [AT_PIP_AUDIT], record: SPENT, costExceeded: true });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toHaveLength(1);
  });

  test("AC-8: a cost-limited run still records the checks left red", async () => {
    const { out } = await publish({ checks: [AT_PIP_AUDIT], record: SPENT, costExceeded: true });
    expect(out.patch.ciRemaining).toEqual([{ name: "Security audit", failedStep: "pip-audit", newFailure: true }]);
  });

  test("AC-9: with no repair allowance and no round run, the checks are never read", async () => {
    const h = harness({ checks: [AT_PIP_AUDIT], limits: NO_CI_REPAIR });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toEqual([]);
  });

  test("AC-10: with no repair allowance and no round run, no checks are recorded", async () => {
    const { out } = await publish({ checks: [AT_PIP_AUDIT], limits: NO_CI_REPAIR });
    expect("ciRemaining" in out.patch).toBe(false);
  });

  test("AC-11: a green CI after the repair round is never read", async () => {
    const h = harness({ checks: [AT_PIP_AUDIT], record: SPENT, published: READY_GREEN });
    const out = await publishStep(h.env, h.env.record);
    expect(h.reads).toEqual([]);
    // The premise: the seams can read, and would have, on a failed CI.
    expect((await publish({ checks: [AT_PIP_AUDIT], record: SPENT })).reads).toHaveLength(1);
    expect(out.patch.ci).toBe("green");
  });

  test("AC-12: an unreadable CI log says so, once", async () => {
    const { ledger } = await publish({ checks: new Error("gh down"), record: SPENT });
    expect(ledger).toContain("CI logs unavailable: gh down");
  });

  test("AC-13: an unreadable CI log records no remaining checks", async () => {
    const { out } = await publish({ checks: new Error("gh down"), record: SPENT });
    expect("ciRemaining" in out.patch).toBe(false);
  });

  test("AC-14: a read that found no failed check records none", async () => {
    const { out } = await publish({ checks: [], record: SPENT });
    expect("ciRemaining" in out.patch).toBe(false);
    // The premise: the read happened.
    expect((await publish({ checks: [], record: SPENT })).reads).toHaveLength(1);
  });

  test("AC-15: a read that found no failed check writes no still-failing note", async () => {
    const { ledger } = await publish({ checks: [], record: SPENT });
    expect(ledger.filter((note) => note.includes("CI still failing"))).toEqual([]);
  });

  test("AC-16: the remaining-CI read never claims a repair is under way", async () => {
    const { ledger } = await publish({ checks: [], record: SPENT });
    expect(ledger.filter((note) => note.includes("(repairing)"))).toEqual([]);
  });

  test("AC-19: a ready publish with a spent round reads nothing", async () => {
    const h = harness({ checks: [AT_PIP_AUDIT], record: SPENT, published: READY_GREEN });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toEqual([]);
  });

  test("AC-20: a round to spare reads the checks exactly once, for the repair", async () => {
    const h = harness({
      checks: [AT_PIP_AUDIT],
      record: { ...SPENT, ciRepairRounds: 1 },
      limits: { ...LIMITS, ciRepairRounds: 2 },
    });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toHaveLength(1);
  });

  test("AC-21: a round to spare schedules the repair", async () => {
    const { out } = await publish({
      checks: [AT_PIP_AUDIT],
      record: { ...SPENT, ciRepairRounds: 1 },
      limits: { ...LIMITS, ciRepairRounds: 2 },
    });
    expect(out.exit).toBe("ci-repair");
  });

  test("AC-22: a round to spare records no remaining checks", async () => {
    const { out } = await publish({
      checks: [AT_PIP_AUDIT],
      record: { ...SPENT, ciRepairRounds: 1 },
      limits: { ...LIMITS, ciRepairRounds: 2 },
    });
    expect("ciRemaining" in out.patch).toBe(false);
  });

  test("the remaining-CI read is asked for the PR's url and the head read after the publish", async () => {
    const h = harness({ checks: [AT_PIP_AUDIT], record: SPENT });
    const env = { ...h.env, steps: { ...h.env.steps, head: async () => "abc123" } };
    await publishStep(env, env.record);
    expect(h.reads).toEqual([{ url: PR_URL, head: "abc123" }]);
  });

  test("without the reader step the publish path records nothing", async () => {
    const { out } = await publish({ record: SPENT });
    expect("ciRemaining" in out.patch).toBe(false);
  });

  test("a check with no failed step carries the name alone, and no empty key", async () => {
    const { out } = await publish({ checks: [E2E], record: SPENT });
    expect(out.patch.ciRemaining).toEqual([{ name: "e2e", newFailure: true }]);
    expect(out.patch.ciRemaining?.[0] ?? {}).not.toHaveProperty("failedStep");
  });

  test("the still-failing note is not mirrored into the run log", async () => {
    const writes: { text: string; mirror: boolean | undefined }[] = [];
    const h = harness({ checks: [E2E], record: SPENT });
    const env = {
      ...h.env,
      sink: {
        ...h.env.sink,
        ledger: async (text: string, options?: { mirror?: boolean }) => {
          writes.push({ text, mirror: options?.mirror });
        },
      },
    };
    await publishStep(env, env.record);
    const note = writes.find((w) => w.text.startsWith("CI still failing"));
    expect(note?.mirror).toBe(false);
  });
});
