/**
 * US-007: the CI repair node of the feature graph.
 *
 * The repair session is the branch-fix session: the failed checks of the published PR become its
 * findings, the round is capped by `workflow.ciRepairRounds`, and the run goes back to the final
 * gates so the repo's own gates are read again before the next publish.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeFeatureMachineHarness } from "@test/helpers";
import type { FailedCheck } from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { validateStepGraph } from "@/step-graph";
import type { BranchFixOutcome } from "@/workflow/branch-fix";
import type { FeatureLimits } from "@/workflow/branch-fix-rounds";
import { FEATURE_GRAPH } from "@/workflow/feature-graph";
import { runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import * as featureSteps from "@/workflow/feature-steps";
import type { PublishOutcome } from "@/workflow/finalize";
import type { LedgerWriteOptions } from "@/workflow/ledger";
import type { WorkflowFeatureRecord, WorkflowFinding, WorkflowFindingDraft } from "@/workflow/types";

/** The limits of a run that may repair CI once. */
const LIMITS: FeatureLimits = { maxBranchFixRounds: 2, finalGateRepairRounds: 1, ciRepairRounds: 1 };

/** The two failed checks of the published PR, as the repair findings the publish step produced. */
const CHECK_E2E: WorkflowFindingDraft = { kind: "gate", severity: "important", issue: "CI check e2e failed:\nboom" };
const CHECK_LINT: WorkflowFindingDraft = { kind: "gate", severity: "important", issue: "CI check lint failed:\nbang" };

const baseRecord = (): WorkflowFeatureRecord => newFeatureRecord({ now: "t", seed: "seed0", minors: [] });

interface StepHarness {
  readonly env: ReturnType<typeof makeFeatureMachineHarness>["env"];
  /** The ledger writes and the fix session, in the order they happened. */
  readonly order: string[];
  readonly ledger: string[];
  /** Every ledger write with the options it carried, so the mirroring is pinned too. */
  readonly writes: readonly LedgerWrite[];
  readonly fixInputs: (readonly WorkflowFinding[])[];
}

/** One ledger write: its text and the write options the step passed. */
interface LedgerWrite {
  readonly text: string;
  readonly options: LedgerWriteOptions | undefined;
}

/** The shared harness, with the ledger and the fix session on one ordered list. */
function stepHarness(
  opts: {
    readonly findings?: readonly WorkflowFindingDraft[];
    readonly rounds?: number;
    readonly limit?: number;
    readonly fix?: BranchFixOutcome;
  } = {},
): StepHarness {
  const base = makeFeatureMachineHarness(
    { ...(opts.fix ? { fix: opts.fix } : {}) },
    {
      limits: { ...LIMITS, ciRepairRounds: opts.limit ?? 1 },
      record: {
        ...baseRecord(),
        ...(opts.findings ? { ciRepairFindings: opts.findings } : {}),
        ...(opts.rounds !== undefined ? { ciRepairRounds: opts.rounds } : {}),
      },
    },
  );
  const order: string[] = [];
  const ledger: string[] = [];
  const writes: LedgerWrite[] = [];
  const env = {
    ...base.env,
    sink: {
      ...base.env.sink,
      ledger: async (text: string, options?: LedgerWriteOptions) => {
        ledger.push(text);
        writes.push({ text, options });
        order.push(`ledger:${text}`);
      },
    },
    steps: {
      ...base.env.steps,
      branchFix: async (findings: Parameters<typeof base.env.steps.branchFix>[0]) => {
        order.push("branchFix");
        return base.env.steps.branchFix(findings);
      },
    },
  };
  return { env, order, ledger, writes, fixInputs: base.fixInputs };
}

describe("the CI repair step (US-007)", () => {
  test("US-012 AC-1 forwards the published PR URL and retains C1", async () => {
    const h = stepHarness({ findings: [CHECK_E2E] });
    const calls: unknown[][] = [];
    h.env.steps.branchFix = async (...args) => {
      calls.push(args);
      return { autoCommitted: false, dirty: false };
    };
    await featureSteps.ciRepairStep(h.env, { ...h.env.record, url: "https://github.com/o/r/pull/7" });
    expect(calls).toEqual([[[{ ...CHECK_E2E, id: "C1" }], { prUrl: "https://github.com/o/r/pull/7" }]]);
  });

  test("US-012 AC-2 ordinary branch fix uses one argument", async () => {
    const h = stepHarness();
    const findings = [{ ...CHECK_E2E, id: "B1" }];
    const calls: unknown[][] = [];
    h.env.steps.branchFix = async (...args) => {
      calls.push(args);
      return { autoCommitted: false, dirty: false };
    };
    await featureSteps.branchFixStep(h.env, { ...h.env.record, reviewOpen: findings });
    expect(calls).toEqual([[findings]]);
  });
  test.each(["ci-without-url", "gate-with-url"])("%s stays unbound", async (mode) => {
    const h = stepHarness({ findings: [CHECK_E2E] });
    const calls: unknown[][] = [];
    h.env.steps.branchFix = async (...args) => {
      calls.push(args);
      return { autoCommitted: false, dirty: false };
    };
    if (mode === "ci-without-url") await featureSteps.ciRepairStep(h.env, h.env.record);
    else
      await featureSteps.gateRepairStep(h.env, {
        ...h.env.record,
        url: "https://github.com/o/r/pull/7",
        gateRepairFindings: [CHECK_E2E],
      });
    expect(calls).toEqual([[[{ ...CHECK_E2E, id: mode === "ci-without-url" ? "C1" : "G1" }]]]);
  });

  test("AC-1: the repair session gets the failed checks as findings C1 and C2", async () => {
    const h = stepHarness({ findings: [CHECK_E2E, CHECK_LINT] });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.fixInputs).toHaveLength(1);
    expect(h.fixInputs[0]).toEqual([
      { ...CHECK_E2E, id: "C1" },
      { ...CHECK_LINT, id: "C2" },
    ]);
  });

  test("AC-2: the repair round is recorded and the repair findings are cleared", async () => {
    const h = stepHarness({ findings: [CHECK_E2E, CHECK_LINT] });
    const out = await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(out.patch.ciRepairRounds).toBe(1);
    expect(out.patch.ciRepairFindings).toBeUndefined();
    // The key is stated, so the record's findings are cleared rather than left behind.
    expect("ciRepairFindings" in out.patch).toBe(true);
  });

  test("AC-3: the ledger names the repair before the session starts", async () => {
    const h = stepHarness({ findings: [CHECK_E2E, CHECK_LINT] });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("CI repair r1: 2 item(s): C1, C2");
    expect(h.order).toEqual(["ledger:CI repair r1: 2 item(s): C1, C2", "branchFix"]);
  });

  test("AC-5: a failed repair session is named in the ledger", async () => {
    const h = stepHarness({
      findings: [CHECK_E2E],
      fix: { failure: "the agent died", autoCommitted: false, dirty: false },
    });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("CI repair session failed: the agent died");
  });

  test("AC-6: an auto-committed repair says so in the ledger", async () => {
    const h = stepHarness({ findings: [CHECK_E2E], fix: { autoCommitted: true, dirty: false } });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("auto-committed the CI repair's edits");
  });

  test("AC-7: a repair that could not commit says so in the ledger", async () => {
    const h = stepHarness({ findings: [CHECK_E2E], fix: { autoCommitted: false, dirty: true } });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("CI repair left uncommitted edits: the auto-commit failed");
  });

  test("AC-8: a spent round runs no repair session", async () => {
    const h = stepHarness({ findings: [CHECK_E2E], rounds: 1, limit: 1 });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.fixInputs).toHaveLength(0);
    expect(h.order).not.toContain("branchFix");
  });

  test("AC-9: a spent round says why it runs no repair session", async () => {
    const h = stepHarness({ findings: [CHECK_E2E], rounds: 1, limit: 1 });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.ledger).toContain("CI repair skipped: round 2 is past workflow.ciRepairRounds (1)");
  });

  test("AC-10: a spent round patches nothing", async () => {
    const h = stepHarness({ findings: [CHECK_E2E], rounds: 1, limit: 1 });
    const out = await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(out.patch).toEqual({});
  });

  test("AC-11: a run with no failed checks to repair runs no repair session", async () => {
    const h = stepHarness({});
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(h.fixInputs).toHaveLength(0);
    expect(h.order).not.toContain("branchFix");
  });

  test("AC-12: a run with no failed checks to repair still spends its round", async () => {
    const h = stepHarness({});
    const out = await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(out.patch).toEqual({ ciRepairRounds: 1 });
  });
});

describe("the CI repair's ledger mirroring (US-007)", () => {
  /** Whether the ledger write of this text is mirrored into the run log; undefined when it is absent. */
  const mirrored = (h: StepHarness, text: string): boolean | undefined => {
    const write = h.writes.find((candidate) => candidate.text === text);
    if (!write) return undefined;
    return write.options?.mirror !== false;
  };

  test("the repair notes are not mirrored, the auto-commit notes are", async () => {
    const h = stepHarness({
      findings: [CHECK_E2E],
      fix: { failure: "the agent died", autoCommitted: true, dirty: true },
    });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(mirrored(h, "CI repair r1: 1 item(s): C1")).toBe(false);
    expect(mirrored(h, "CI repair session failed: the agent died")).toBe(false);
    expect(mirrored(h, "auto-committed the CI repair's edits")).toBe(true);
    expect(mirrored(h, "CI repair left uncommitted edits: the auto-commit failed")).toBe(true);
  });

  test("a spent round's skip note is not mirrored", async () => {
    const h = stepHarness({ findings: [CHECK_E2E], rounds: 1, limit: 1 });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    const skip = h.writes.find((write) => write.text.startsWith("CI repair skipped:"));
    expect(skip?.options?.mirror).toBe(false);
  });
});

describe("the CI repair step's log line (US-007)", () => {
  let logs: LogEntry[] = [];
  beforeEach(() => {
    resetLogger();
    logs = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
  });
  afterEach(() => resetLogger());

  const workflowLines = () => logs.filter((entry) => entry.stage === "workflow").map((entry) => entry.message);

  test("AC-4: the second round's start line is labelled ci-repair r2", async () => {
    const h = stepHarness({ findings: [CHECK_E2E], rounds: 1, limit: 2 });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(workflowLines()).toContain("ci-repair r2 start");
  });

  test("the first round's start line is labelled ci-repair", async () => {
    const h = stepHarness({ findings: [CHECK_E2E] });
    await featureSteps.ciRepairStep(h.env, h.env.record);
    expect(workflowLines()).toContain("ci-repair start");
  });
});

describe("the final gates after a CI repair (US-007)", () => {
  const recordAfter = (over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord => ({
    ...baseRecord(),
    repoGates: { ran: ["build", "test"], failing: [] },
    fixRan: false,
    ...over,
  });

  test("AC-13: the repo gates run again when a CI repair repaired the branch", async () => {
    const h = makeFeatureMachineHarness({}, { record: recordAfter({ ciRepairRounds: 1 }) });
    const out = await featureSteps.finalGatesStep(h.env, h.env.record);
    expect(h.calls).toContain("repoGates");
    expect(out.exit).toBe("green");
  });

  test("a run with no CI repair reuses the repo gates it already read", async () => {
    const h = makeFeatureMachineHarness({}, { record: recordAfter() });
    const out = await featureSteps.finalGatesStep(h.env, h.env.record);
    expect(h.calls).not.toContain("repoGates");
    expect(out.exit).toBe("reused");
  });
});

describe("the CI repair node in the feature graph (US-007)", () => {
  test("AC-14: the graph validates with the CI repair node in it", () => {
    expect(validateStepGraph(FEATURE_GRAPH)).toEqual({ errors: [] });
    expect(FEATURE_GRAPH.nodes["ci-repair"]).toBeDefined();
  });

  test("AC-15: the CI repair node is an agent node that commits", () => {
    const node = FEATURE_GRAPH.nodes["ci-repair"];
    expect(node?.kind).toBe("agent");
    expect(node?.commits).toBe(true);
  });

  test("AC-16: the CI repair node goes back to the final gates", () => {
    const node = FEATURE_GRAPH.nodes["ci-repair"];
    expect(node?.transitions.map(({ to }) => to)).toEqual(["final-gates"]);
  });

  test("AC-22: the cost stop skips the CI repair to the final gates", async () => {
    const h = makeFeatureMachineHarness(
      {},
      {
        costExceeded: () => true,
        record: { ...baseRecord(), ciRepairFindings: [CHECK_E2E] },
      },
    );
    expect(await FEATURE_GRAPH.costStop?.("ci-repair", h.env.record, h.env)).toEqual({
      patch: { costLimited: true },
      to: "final-gates",
    });
  });

  test("the cost stop leaves a CI repair with nothing to repair alone", async () => {
    const h = makeFeatureMachineHarness({}, { costExceeded: () => true, record: baseRecord() });
    expect(await FEATURE_GRAPH.costStop?.("ci-repair", h.env.record, h.env)).toBeUndefined();
  });
});

describe("the CI repair in a run (US-007)", () => {
  const PR_URL = "https://github.com/o/r/pull/42";
  const DRAFT_FAILED: PublishOutcome = {
    outcome: "draft",
    ci: "failed",
    url: PR_URL,
    reasons: ["CI failed on the branch"],
  };
  const READY_GREEN: PublishOutcome = { outcome: "ready", ci: "green", url: PR_URL, reasons: [] };
  const CI_CHECKS: readonly FailedCheck[] = [{ name: "e2e", excerpt: "boom" }];

  /** A run whose publish returns the given outcomes, the last one repeating. */
  const run = (opts: { readonly publishedSeq: PublishOutcome[]; readonly fix?: BranchFixOutcome }) =>
    makeFeatureMachineHarness(
      { publishedSeq: opts.publishedSeq, ciFailures: CI_CHECKS, ...(opts.fix ? { fix: opts.fix } : {}) },
      { limits: LIMITS },
    );

  /** The positions of every call of one name, in the order they happened. */
  const callsAt = (calls: readonly string[], name: string): number[] =>
    calls.reduce<number[]>((acc, call, i) => {
      if (call === name) acc.push(i);
      return acc;
    }, []);

  test("AC-17: the run repairs the failed check once, as finding C1", async () => {
    const h = run({ publishedSeq: [DRAFT_FAILED, READY_GREEN] });
    await runFeatureMachine(h.env);
    expect(h.calls.filter((call) => call === "branchFix")).toHaveLength(1);
    expect(h.fixInputs[0]?.map((f) => f.id)).toEqual(["C1"]);
  });

  test("AC-18: the repo gates run again between the CI repair and the second publish", async () => {
    const h = run({ publishedSeq: [DRAFT_FAILED, READY_GREEN] });
    await runFeatureMachine(h.env);
    const gates = callsAt(h.calls, "repoGates");
    const publishes = callsAt(h.calls, "publish");
    const fixes = callsAt(h.calls, "branchFix");
    expect(gates).toHaveLength(2);
    expect(publishes).toHaveLength(2);
    expect(fixes).toHaveLength(1);
    assertDefined(gates[1], "the second repo gates call");
    assertDefined(fixes[0], "the CI repair call");
    assertDefined(publishes[1], "the second publish call");
    expect(gates[1]).toBeGreaterThan(fixes[0]);
    expect(gates[1]).toBeLessThan(publishes[1]);
  });

  test("AC-19: the run ends with the repair round recorded and a ready outcome", async () => {
    const h = run({ publishedSeq: [DRAFT_FAILED, READY_GREEN] });
    const record = await runFeatureMachine(h.env);
    expect(record.ciRepairRounds).toBe(1);
    expect(record.outcome).toBe("ready");
  });

  test("AC-20: a CI that stays failed publishes twice", async () => {
    const h = run({ publishedSeq: [DRAFT_FAILED] });
    await runFeatureMachine(h.env);
    expect(h.calls.filter((call) => call === "publish")).toHaveLength(2);
  });

  test("AC-21: a CI that stays failed is repaired once", async () => {
    const h = run({ publishedSeq: [DRAFT_FAILED] });
    await runFeatureMachine(h.env);
    expect(h.calls.filter((call) => call === "branchFix")).toHaveLength(1);
  });

  test("AC-23: a repair session that fails leaves the PR a draft", async () => {
    const h = run({
      publishedSeq: [DRAFT_FAILED],
      fix: { failure: "the agent died", autoCommitted: false, dirty: false },
    });
    const record = await runFeatureMachine(h.env);
    expect(record.outcome).toBe("draft");
    expect(record.ciRepairRounds).toBe(1);
    // The final gates and the publish ran again after the repair.
    expect(h.calls.filter((call) => call === "repoGates")).toHaveLength(2);
    expect(h.calls.filter((call) => call === "publish")).toHaveLength(2);
  });
});
