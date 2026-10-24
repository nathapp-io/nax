/**
 * US-006: the CI repair decision the publish step makes when the published PR's CI failed.
 *
 * The decision reads the failed checks through the optional `readCiFailures` step and either hands
 * them to the repair node (exit `ci-repair`) or leaves the publish outcome exactly as it was. Every
 * other outcome — a ready PR, a pending CI, spent rounds, a cost-limited run, an unreadable log —
 * must reach the same publish result as before this decision existed.
 *
 * Every "no repair" case carries its control: the same seams with the one input that makes the
 * decision act. Without it, an absent decision and a decision that never fires look the same.
 */
import { describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import { NaxError } from "@/errors";
import type { FailedCheck } from "@/forge";
import { markdownFence } from "@/utils/markdown-fence";
import type { FeatureLimits } from "@/workflow/branch-fix-rounds";
import type { FeatureEnv, FeatureSteps } from "@/workflow/feature-machine";
import { FEATURE_STEPS, newFeatureRecord } from "@/workflow/feature-record";
import { ciRepairDecision, publishStep } from "@/workflow/feature-steps";
import type { PublishOutcome } from "@/workflow/finalize";
import type { LedgerWriteOptions } from "@/workflow/ledger";
import type { WorkflowFeatureRecord } from "@/workflow/types";

const HEAD = "abc123";
const PR_URL = "https://github.com/o/r/pull/42";

/** The limits of a run that may repair CI once. */
const LIMITS: FeatureLimits = { maxBranchFixRounds: 2, finalGateRepairRounds: 1, ciRepairRounds: 1 };

/** The limits of a run with no CI repair allowance at all. */
const NO_CI_REPAIR: FeatureLimits = { maxBranchFixRounds: 2, finalGateRepairRounds: 1 };

const DRAFT_FAILED: PublishOutcome = {
  outcome: "draft",
  ci: "failed",
  url: PR_URL,
  reasons: ["CI failed on the branch"],
};

const READY: PublishOutcome = { outcome: "ready", ci: "green", url: PR_URL, reasons: [] };
const PENDING: PublishOutcome = { outcome: "draft", ci: "pending", url: PR_URL, reasons: ["CI still pending"] };

/** One failed check, with the url the finding points at. */
const E2E: FailedCheck = { name: "e2e", url: "u", excerpt: "boom" };

const never = async (): Promise<never> => {
  throw new Error("step not expected in this test");
};

interface HarnessOpts {
  /** What the publish step returns. */
  readonly published?: PublishOutcome;
  /** The failed checks the reader returns; an Error rejects the read. Absent wires no reader. */
  readonly checks?: readonly FailedCheck[] | Error;
  readonly limits?: FeatureLimits;
  /** The run's cost check; absent means the run may spend. */
  readonly costExceeded?: boolean;
  readonly record?: Partial<WorkflowFeatureRecord>;
}

/** A publish step with only the three seams the CI repair decision reads. */
function harness(opts: HarnessOpts = {}) {
  const ledger: string[] = [];
  /** Every ledger write with the options it carried, so the mirroring is pinned too. */
  const writes: { text: string; options: LedgerWriteOptions | undefined }[] = [];
  const reads: { url: string; head: string }[] = [];
  const checks = opts.checks;
  const steps: FeatureSteps = {
    repoGates: never,
    branchReview: never,
    branchFix: never,
    branchReReview: never,
    adjudicate: never,
    publish: async () => opts.published ?? DRAFT_FAILED,
    head: async () => HEAD,
    changedFiles: async () => [],
    ...(checks !== undefined
      ? {
          readCiFailures: async (input: { url: string; head: string }) => {
            reads.push(input);
            if (checks instanceof Error) throw checks;
            return checks;
          },
        }
      : {}),
  };
  const env: FeatureEnv = {
    steps,
    sink: {
      update: async () => {},
      ledger: async (text, options) => {
        ledger.push(text);
        writes.push({ text, options });
      },
      step: () => {},
      artifact: async () => {},
    },
    facts: { stories: [], parked: [], cannotVerify: [] },
    record: { ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }), ...opts.record },
    aborted: () => false,
    now: () => 0,
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.costExceeded ? { costExceeded: () => true } : {}),
  };
  return { env, ledger, writes, reads };
}

/** How many CI reads the publish step made with these seams. */
async function readsOf(opts: HarnessOpts): Promise<number> {
  const h = harness(opts);
  await publishStep(h.env, h.env.record);
  return h.reads.length;
}

describe("CI repair needs readable evidence (US-003)", () => {
  const unreadable: readonly FailedCheck[] = [
    { name: "e2e", excerpt: "log unavailable", logUnavailable: true },
    { name: "lint", excerpt: "log unavailable", logUnavailable: true },
  ];

  test("AC-11: all unavailable logs return no repair and preserve the draft", async () => {
    const h = harness({ checks: unreadable, limits: LIMITS });
    expect(await ciRepairDecision(h.env, h.env.record, DRAFT_FAILED, HEAD)).toBeUndefined();
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    expect(out.patch).toMatchObject({ outcome: "draft", ci: "failed", url: PR_URL });
    expect(out.patch.ciRepairFindings).toBeUndefined();
  });

  test("AC-12: the ledger explains the unreadable-log skip", async () => {
    const h = harness({ checks: unreadable, limits: LIMITS });
    await ciRepairDecision(h.env, h.env.record, DRAFT_FAILED, HEAD);
    expect(h.ledger).toEqual(["CI repair skipped: no failed check's log could be read (e2e, lint)"]);
    expect(h.writes[0]?.options?.mirror).toBe(false);
  });

  test("AC-13: mixed evidence keeps one finding per failed check", async () => {
    const h = harness({ checks: [unreadable[1] ?? E2E, E2E], limits: LIMITS });
    expect(await ciRepairDecision(h.env, h.env.record, DRAFT_FAILED, HEAD)).toEqual([
      { kind: "gate", severity: "important", issue: `CI check lint failed:\n${markdownFence("log unavailable")}` },
      {
        kind: "gate",
        severity: "important",
        issue: `CI check e2e failed:\n${markdownFence("boom")}`,
        suggestion: "See u",
      },
    ]);
  });
});

describe("the CI repair decision after publish (US-006)", () => {
  test("AC-4: FEATURE_STEPS includes the ci-repair step", () => {
    expect(FEATURE_STEPS).toContain("ci-repair");
  });

  test("AC-5: a draft with failed CI hands the failed checks to the repair node", async () => {
    const h = harness({ checks: [E2E], limits: LIMITS });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBe("ci-repair");
    expect(out.patch.ciRepairFindings).toEqual([
      {
        kind: "gate",
        severity: "important",
        issue: `CI check e2e failed:\n${markdownFence("boom")}`,
        suggestion: "See u",
      },
    ]);
  });

  test("AC-6: the reader is asked for the PR's url and the head read after the publish", async () => {
    const h = harness({ checks: [E2E], limits: LIMITS });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toEqual([{ url: PR_URL, head: HEAD }]);
  });

  test("AC-7: the ledger names the failed checks it is repairing", async () => {
    const h = harness({
      checks: [
        { name: "e2e", excerpt: "boom" },
        { name: "lint", excerpt: "bang" },
      ],
      limits: LIMITS,
    });
    await publishStep(h.env, h.env.record);
    expect(h.ledger).toContain("CI failed: e2e, lint (repairing)");
  });

  test("AC-8: a ready publish is not a repair", async () => {
    const h = harness({ published: READY, checks: [E2E], limits: LIMITS });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    // The control: the same seams with a failed CI do repair.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-9: a ready publish reads no CI logs", async () => {
    const h = harness({ published: READY, checks: [E2E], limits: LIMITS });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toEqual([]);
    // The control: the same seams with a failed CI do read.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-10: a pending CI is not a repair", async () => {
    const h = harness({ published: PENDING, checks: [E2E], limits: LIMITS });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    // The control: the same seams with a failed CI do repair.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-11: a pending CI reads no CI logs", async () => {
    const h = harness({ published: PENDING, checks: [E2E], limits: LIMITS });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toEqual([]);
    // The control: the same seams with a failed CI do read.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-12: the repair rounds already spent are not repaired again", async () => {
    const h = harness({ checks: [E2E], limits: LIMITS, record: { ciRepairRounds: 1 } });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    // The control: the same seams with a round to spare do repair.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-13: spent repair rounds decide no repair, and read the checks once for the record", async () => {
    const h = harness({ checks: [E2E], limits: LIMITS, record: { ciRepairRounds: 1 } });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).not.toBe("ci-repair");
    // US-006: the one read is the remaining-CI read, not a repair decision.
    expect(h.reads).toHaveLength(1);
    // The control: the same seams with a round to spare read the checks once, and do repair.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-14: limits without a CI repair allowance are not repaired", async () => {
    const h = harness({ checks: [E2E], limits: NO_CI_REPAIR });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    // The control: the same seams with an allowance do repair.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-15: limits without a CI repair allowance read no CI logs", async () => {
    const h = harness({ checks: [E2E], limits: NO_CI_REPAIR });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toEqual([]);
    // The control: the same seams with an allowance do read.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-16: a cost-limited run is not repaired", async () => {
    const h = harness({ checks: [E2E], limits: LIMITS, costExceeded: true });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    // The control: the same seams with cost to spare do repair.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-17: a cost-limited run reads no CI logs", async () => {
    const h = harness({ checks: [E2E], limits: LIMITS, costExceeded: true });
    await publishStep(h.env, h.env.record);
    expect(h.reads).toEqual([]);
    // The control: the same seams with cost to spare do read.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });

  test("AC-18: no failed check to repair is not a repair", async () => {
    const h = harness({ checks: [], limits: LIMITS });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    // The premise: the CI logs were read, and named no failed check.
    expect(h.reads).toHaveLength(1);
  });

  test("AC-19: no failed check to repair says so, and names the head", async () => {
    const h = harness({ checks: [], limits: LIMITS });
    await publishStep(h.env, h.env.record);
    expect(h.ledger).toContain(`CI failed but no failed check was found for ${HEAD}`);
  });

  test("AC-20: an unreadable CI log is not a repair", async () => {
    const h = harness({ checks: new Error("nope"), limits: LIMITS });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    // The premise: the CI logs were read, and the read failed.
    expect(h.reads).toHaveLength(1);
  });

  test("AC-21: an unreadable CI log says why, in the ledger", async () => {
    const h = harness({ checks: new Error("nope"), limits: LIMITS });
    await publishStep(h.env, h.env.record);
    expect(h.ledger).toContain("CI logs unavailable: nope");
  });

  test("AC-22: a failed CI listing keeps the ordinary draft outcome", async () => {
    const h = harness({
      checks: new NaxError("[forge] Cannot read the CI checks: gh failed", "FORGE_CI_READ_FAILED", {
        stage: "forge",
      }),
      limits: LIMITS,
    });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    expect(out.patch.outcome).toBe("draft");
    expect(out.patch.ci).toBe("failed");
    expect(out.patch.url).toBe(PR_URL);
    // The premise: the CI logs were read, and the listing failed.
    expect(h.reads).toHaveLength(1);
  });

  test("AC-23: without the reader step the publish path is unchanged", async () => {
    const h = harness({ limits: LIMITS });
    const out = await publishStep(h.env, h.env.record);
    expect(out.exit).toBeUndefined();
    expect(out.patch.outcome).toBe("draft");
    expect(out.patch.ci).toBe("failed");
    expect("ciRepairFindings" in out.patch).toBe(false);
    // The control: the same seams with the reader wired do read the logs.
    expect(await readsOf({ checks: [E2E], limits: LIMITS })).toBe(1);
  });
});

describe("the CI repair decision's ledger mirroring (US-006)", () => {
  /** Whether the ledger write of this text is mirrored into the run log. */
  const mirrored = (writes: readonly { text: string; options: LedgerWriteOptions | undefined }[], text: string) =>
    writes.find((write) => write.text === text)?.options?.mirror;

  test("the repair note is not mirrored", async () => {
    const h = harness({ checks: [E2E], limits: LIMITS });
    await publishStep(h.env, h.env.record);
    expect(mirrored(h.writes, "CI failed: e2e (repairing)")).toBe(false);
  });

  test("the empty-list note is not mirrored", async () => {
    const h = harness({ checks: [], limits: LIMITS });
    await publishStep(h.env, h.env.record);
    expect(mirrored(h.writes, `CI failed but no failed check was found for ${HEAD}`)).toBe(false);
  });

  test("the unreadable-log note is not mirrored", async () => {
    const h = harness({ checks: new Error("nope"), limits: LIMITS });
    await publishStep(h.env, h.env.record);
    expect(mirrored(h.writes, "CI logs unavailable: nope")).toBe(false);
  });
});

/**
 * US-004: a finding that names only the check sends the repair at the first failure and leaves the
 * steps behind it unrun. The issue carries the failed step and the steps the job then skipped.
 */
describe("the failed and skipped steps in the finding's issue (US-004)", () => {
  /** The issue the publish step patched for one failed check. */
  async function issueOf(check: FailedCheck): Promise<string | undefined> {
    const h = harness({ checks: [check], limits: LIMITS });
    const out = await publishStep(h.env, h.env.record);
    return out.patch.ciRepairFindings?.[0]?.issue;
  }

  test("US-008 AC-7 fences embedded triple backticks with four backticks", async () => {
    expect(await issueOf({ name: "e2e", excerpt: "before\n```\nafter" })).toBe(
      "CI check e2e failed:\n````\nbefore\n```\nafter\n````",
    );
  });

  const STEPPED: FailedCheck = {
    name: "Security audit",
    failedStep: "bun audit",
    skippedSteps: ["pip-audit"],
    excerpt: "E",
  };

  test("AC-13: the issue names the step that failed", async () => {
    expect(await issueOf(STEPPED)).toStartWith('CI check Security audit failed at step "bun audit".');
  });

  test("AC-14: the skipped steps are a line of their own, naming what never ran", async () => {
    const issue = await issueOf(STEPPED);
    expect(issue).toContain("\nSteps CI skipped after it, which never ran: pip-audit\n");
  });

  test("AC-15: the step, the skipped line and the excerpt, each on its own line", async () => {
    expect(await issueOf(STEPPED)).toBe(
      `CI check Security audit failed at step "bun audit".\nSteps CI skipped after it, which never ran: pip-audit\n${markdownFence("E")}`,
    );
  });

  test("AC-16: a failed step with nothing skipped after it omits the skipped line", async () => {
    expect(await issueOf({ name: "Security audit", failedStep: "bun audit", excerpt: "E" })).toBe(
      `CI check Security audit failed at step "bun audit".\n${markdownFence("E")}`,
    );
  });

  test("AC-17: a check with no step facts keeps the plain failure text", async () => {
    expect(await issueOf({ name: "Security audit", excerpt: "E" })).toBe(
      `CI check Security audit failed:\n${markdownFence("E")}`,
    );
  });

  test("several skipped steps are listed in job order", async () => {
    expect(
      await issueOf({
        name: "Security audit",
        failedStep: "bun audit",
        skippedSteps: ["pip-audit", "cargo audit"],
        excerpt: "E",
      }),
    ).toContain("Steps CI skipped after it, which never ran: pip-audit, cargo audit\n");
  });
});

describe("the shared harness's CI repair seams (US-006)", () => {
  test("the scripted publish outcomes come in order, and the last one repeats", async () => {
    const seq: PublishOutcome[] = [
      { outcome: "draft", ci: "failed", url: PR_URL, reasons: [] },
      { outcome: "ready", ci: "green", url: PR_URL, reasons: [] },
    ];
    const h = makeFeatureMachineHarness({ publishedSeq: seq });
    const first = await h.env.steps.publish(h.env.record);
    const second = await h.env.steps.publish(h.env.record);
    const third = await h.env.steps.publish(h.env.record);
    expect([first.outcome, second.outcome, third.outcome]).toEqual(["draft", "ready", "ready"]);
    // The script's own array is untouched, so a caller may reuse it.
    expect(seq).toHaveLength(2);
  });

  test("the harness wires the CI reader and records what it was asked for", async () => {
    const checks: readonly FailedCheck[] = [{ name: "e2e", excerpt: "boom" }];
    const h = makeFeatureMachineHarness({ ciFailures: checks });
    const reader = h.env.steps.readCiFailures;
    if (!reader) throw new Error("the harness must wire steps.readCiFailures");
    expect(await reader({ url: PR_URL, head: HEAD })).toEqual(checks);
    expect(h.ciFailureInputs).toEqual([{ url: PR_URL, head: HEAD }]);
    expect(h.calls).toContain("readCiFailures");
  });

  test("the harness rejects the CI read when the script says so", async () => {
    const h = makeFeatureMachineHarness({ ciFailures: new Error("nope") });
    const reader = h.env.steps.readCiFailures;
    if (!reader) throw new Error("the harness must wire steps.readCiFailures");
    await expect(reader({ url: PR_URL, head: HEAD })).rejects.toThrow("nope");
  });

  test("a harness without the CI options wires no reader and keeps the fixed publish outcome", async () => {
    const h = makeFeatureMachineHarness({});
    expect(h.env.steps.readCiFailures).toBeUndefined();
    const published = await h.env.steps.publish(h.env.record);
    expect(published.outcome).toBe("ready");
    expect(published.ci).toBe("pending");
  });
});
