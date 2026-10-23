/**
 * US-002 (nax#2666): the reordered publish's failure paths and the CI repair round.
 *
 * US-001 moved the approval advisor in front of the single ledger commit and the push, so the ruling
 * is already taken when everything that can fail afterwards fails. Nothing here may change what
 * publishing does about that: an advisor that decided nothing or threw, a ledger commit that failed, a
 * rejected push and an abort during the CI wait each keep their ruled outcome — and a second publish
 * round (the CI repair) asks again and pushes again.
 *
 * The deletions this story makes (`commitApprovalRuling`, `PublishOutcome.pushedHead` and
 * `waitForCi`'s `pushedHead`) are what the last describe pins from the outside: with no pushed head
 * left to prefer, `publishStep` hands item threads and the CI-repair read the local HEAD it reads
 * after `publish`, which the advisor's pre-push ledger commit made the pushed head.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  makeDoneStory,
  makeFeatureContext,
  makeFeatureMachineHarness,
  makeFinalizeAdvisor,
  wireFinalize,
  withTempDir,
} from "@test/helpers";
import { type AdviceDecision, type Advisor, ledgerPath, type QuestionDraft } from "@/advisor";
import { _featureDeps } from "@/workflow/feature-deps";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import { publishStep } from "@/workflow/feature-steps";
import { type PublishInput, type PublishOutcome, publish } from "@/workflow/finalize";
import type { ItemThreadsInput } from "@/workflow/item-threads-post";
import { _workflowDeps } from "@/workflow/step-context";
import type { StorySummary } from "@/workflow/types";

const originalFeature = { ..._featureDeps };
const originalWorkflow = { ..._workflowDeps };
afterEach(() => {
  Object.assign(_featureDeps, originalFeature);
  Object.assign(_workflowDeps, originalWorkflow);
});

const DONE: StorySummary = { id: "US-001", title: "A", state: "complete", rounds: 1, unreviewed: false, flagged: 0 };
const URL = "https://gh/pr/7";
const LOCAL_HEAD = "a".repeat(40);
/** A head distinct from `LOCAL_HEAD`: what the retired nax#2646 `pushedHead` would have claimed. */
const LEGACY_PUSHED = "b".repeat(40);
/** The ledger gap a failed commit leaves: the one line the test wrote is not on the branch. */
const LEDGER_REASON = "advisor ledger not committed: the branch is missing 1 advisor rulings";

type Ci = "green" | "failed" | "pending";
type AdviseMode = "approve" | "silent" | "throws";

interface HarnessOptions {
  /** The CI result a single publish round waits out; ignored when `ciQueue` is set. */
  readonly ci?: Ci;
  /** Per-wait CI results, for two publishes on one context (the CI repair path). */
  readonly ciQueue?: readonly Ci[];
  readonly advise?: AdviseMode;
  /** The decision ids the advisor writes, in call order; absent leaves `makeFinalizeAdvisor`'s. */
  readonly decisionIds?: readonly string[];
  readonly pushFails?: boolean;
  /** 1-based `commitLedger` call that throws instead of answering. */
  readonly ledgerThrowsAt?: number;
  readonly onCi?: () => void;
  readonly projectDir?: string;
  readonly runSignal?: AbortSignal;
}

/**
 * One `publish` round over the `wireFinalize` harness, with the advisor *inside* the call log (the
 * pattern US-001's `finalize-approval-order.test.ts` established), so one sequence shows the whole
 * round: the ruling, the ledger commit, the push, the draft, the CI wait and the promotion.
 */
function harness(opts: HarnessOptions = {}) {
  const calls = wireFinalize({
    ...(opts.ci ? { ci: opts.ci } : {}),
    ...(opts.ciQueue ? { ciQueue: opts.ciQueue } : {}),
    ...(opts.pushFails ? { pushFails: true } : {}),
    ...(opts.ledgerThrowsAt ? { ledgerThrowsAt: opts.ledgerThrowsAt } : {}),
    ...(opts.onCi ? { onCi: opts.onCi } : {}),
    // A temp project dir holds no repo to resolve a spec in; the PR body simply has none.
    ...(opts.projectDir ? { spec: null } : {}),
  });
  // The ledger as the advisor leaves it: empty until `advise` writes its decision.
  const ledger: AdviceDecision[] = [];
  _workflowDeps.readTrustedDecisions = async () => [...ledger];
  const asked: QuestionDraft[] = [];
  const ids = [...(opts.decisionIds ?? [])];
  const base = makeFinalizeAdvisor(true);
  const advisor: Advisor = {
    ...base,
    advise: async (question) => {
      asked.push(question);
      calls.push({ name: "advise" });
      if (opts.advise === "throws") throw new Error("advisor offline");
      if (opts.advise === "silent") return { decision: null, fallbackReason: "offline" };
      const answer = await base.advise(question);
      const id = ids.shift();
      const decision = answer.decision && id ? { ...answer.decision, id } : answer.decision;
      if (decision) ledger.push(decision);
      return { ...answer, decision };
    },
  };
  const fc = makeFeatureContext({
    ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
    ...(opts.runSignal ? { runSignal: opts.runSignal } : {}),
  });
  const input: PublishInput = {
    record: {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      reviewRan: true,
      finalGates: { ran: ["test"], failing: [] },
    },
    stories: [DONE],
    flagged: 0,
    advisor,
    preflight: null,
  };
  return {
    asked,
    names: (): string[] => calls.map((call) => call.name),
    /** The publish round. The same context and input every call, so a second call is the CI repair. */
    run: (): Promise<PublishOutcome> => publish(fc, input),
  };
}

describe("publish survives an advisor that never ruled (US-002)", () => {
  test("AC-1: an advisor with no decision still pushes — CI runs and the draft shows its state", async () => {
    const h = harness({ ci: "green", advise: "silent" });
    await h.run();
    expect(h.names()).toEqual(["advise", "ledger", "push", "draft", "ci", "promote"]);
  });

  test("AC-2: an advisor with no decision keeps the PR a draft, and says it was unavailable", async () => {
    const h = harness({ ci: "green", advise: "silent" });
    const out = await h.run();
    expect(out.outcome).toBe("draft");
    expect(out.reasons.some((reason) => reason.startsWith("advisor unavailable:"))).toBe(true);
    expect(out.reasons).toContain("advisor unavailable: offline");
  });

  test("AC-3: an advisor that throws still commits the ledger, pushes, drafts and waits — in that order", async () => {
    const h = harness({ ci: "green", advise: "throws" });
    await h.run();
    expect(h.names()).toEqual(["advise", "ledger", "push", "draft", "ci", "promote"]);
  });

  test("AC-4: an advisor that throws keeps the PR a draft, and says it was unavailable", async () => {
    const h = harness({ ci: "green", advise: "throws" });
    const out = await h.run();
    expect(out.outcome).toBe("draft");
    expect(out.reasons).toContain("advisor unavailable: advisor offline");
  });
});

describe("publish survives a failed ledger commit (US-002)", () => {
  /**
   * The ledger failure is read from the feature's own ledger file, so the test writes exactly one line
   * into its own temp project directory — never a shared repository ledger whose line count other
   * tests (and other runs) would decide.
   */
  const withLedgerLine = (fn: (projectDir: string) => Promise<void>) =>
    withTempDir(async (dir) => {
      await Bun.write(ledgerPath(dir, "f"), `${JSON.stringify({ id: "D-1" })}\n`);
      await fn(dir);
    });

  test("AC-5: an approving advisor whose ledger commit fails still ends as a draft PR", async () => {
    await withLedgerLine(async (projectDir) => {
      const h = harness({ ci: "green", ledgerThrowsAt: 1, projectDir });
      const out = await h.run();
      // The adjudication ran: the advisor approved and CI was green, and only the ledger stopped it.
      expect(out.approval).toMatchObject({ approved: true });
      expect(out.ci).toBe("green");
      expect(out.outcome).toBe("draft");
    });
  });

  test("AC-6: that draft's reasons name the rulings the branch is missing", async () => {
    await withLedgerLine(async (projectDir) => {
      const h = harness({ ci: "green", ledgerThrowsAt: 1, projectDir });
      const out = await h.run();
      expect(out.reasons).toContain(LEDGER_REASON);
    });
  });
});

describe("publish survives a rejected push (US-002)", () => {
  test("AC-7: an approving advisor whose push fails ends local-only with the push failure", async () => {
    const h = harness({ ci: "green", pushFails: true });
    const out = await h.run();
    expect(out.outcome).toBe("local-only");
    expect(out.ci).toBe("skipped");
    expect(out.reasons.at(-1)?.startsWith("push failed:")).toBe(true);
  });

  test("AC-8: that run never opens a draft and never waits for CI", async () => {
    const h = harness({ ci: "green", pushFails: true });
    await h.run();
    expect(h.names()).toEqual(["advise", "ledger", "push"]);
  });
});

describe("publish stopped by an aborted CI wait (US-002)", () => {
  /** An abort that lands while the CI wait is running, so the publish stops right after it. */
  function abortingOnCi() {
    const controller = new AbortController();
    return { controller, onCi: () => controller.abort() };
  }

  const rejection = async (run: () => Promise<PublishOutcome>): Promise<unknown> =>
    run().then(
      () => null,
      (err: unknown) => err,
    );

  test("AC-9: an abandoned run rejects with WORKFLOW_ABORTED, not a publish outcome", async () => {
    const { controller, onCi } = abortingOnCi();
    const h = harness({ ci: "pending", onCi, runSignal: controller.signal });
    expect(await rejection(h.run)).toMatchObject({ code: "WORKFLOW_ABORTED" });
  });

  test("AC-10: an abandoned run never promotes the PR", async () => {
    const { controller, onCi } = abortingOnCi();
    const h = harness({ ci: "pending", onCi, runSignal: controller.signal });
    await rejection(h.run);
    expect(h.names()).toEqual(["advise", "ledger", "push", "draft", "ci"]);
    expect(h.names()).not.toContain("promote");
  });
});

describe("the CI repair round publishes again (US-002)", () => {
  const repair = () => harness({ ciQueue: ["failed", "green"], decisionIds: ["D-1", "D-2"] });

  test("AC-11: two publishes on one context ask, commit, push, draft and wait once each per round", async () => {
    const h = repair();
    await h.run();
    await h.run();
    expect(h.names()).toEqual([
      "advise",
      "ledger",
      "push",
      "draft",
      "ci",
      "promote",
      "advise",
      "ledger",
      "push",
      "draft",
      "ci",
      "promote",
    ]);
  });

  test("AC-12: the first round's red CI keeps its draft, with the decision the advisor took before it", async () => {
    const h = repair();
    const first = await h.run();
    expect(first.outcome).toBe("draft");
    expect(first.approval).toMatchObject({ approved: true, decisionId: "D-1" });
  });

  test("AC-13: the second round's green CI makes the PR ready, with its own decision", async () => {
    const h = repair();
    await h.run();
    const second = await h.run();
    expect(second.outcome).toBe("ready");
    expect(second.approval).toMatchObject({ approved: true, decisionId: "D-2" });
  });
});

/**
 * A publish result that still carries the retired nax#2646 `pushedHead`. `PublishOutcome` has no such
 * field any more, so the extra key is declared here: without it the fixtures below could not offer the
 * head the deleted `out.pushedHead ?? head` fallback preferred, and their assertions could not tell the
 * two behaviours apart (F1).
 */
type WithLegacyPushedHead = PublishOutcome & { readonly pushedHead?: string };

/** `publishStep` with the publish stub of the test's choosing and a `head` step that answers `LOCAL_HEAD`. */
function stepHarness(out: WithLegacyPushedHead) {
  const base = makeFeatureMachineHarness({ published: out }, { stories: [makeDoneStory("S1")] });
  const inputs: ItemThreadsInput[] = [];
  const env: FeatureEnv = {
    ...base.env,
    itemThreadsIdentity: { projectDir: "/captured/repo", feature: "demo" },
    steps: {
      ...base.env.steps,
      head: async () => LOCAL_HEAD,
      changedFiles: async () => ["file.ts"],
      postItemThreads: async (input) => {
        inputs.push(input);
        return { posted: 0, closed: 0, skipped: 0, failed: 0 };
      },
    },
  };
  return { env, inputs };
}

describe("publishStep hands the local head downstream (US-002)", () => {
  test("AC-14: a ready publish hands the item-threads step the local HEAD, not the retired pushed head", async () => {
    const h = stepHarness({ outcome: "ready", url: URL, ci: "green", reasons: [], pushedHead: LEGACY_PUSHED });
    const out = await publishStep(h.env, h.env.record);
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]?.head).toBe(LOCAL_HEAD);
    // The record keeps the same local HEAD; with the ruling in the pre-push commit they are one sha.
    expect(out.patch?.head).toBe(LOCAL_HEAD);
  });

  test("AC-14 discriminates: the retired fallback would have cited a different head", async () => {
    // The expression US-002 deleted, run against the very fixture AC-14 uses: it answers the legacy head,
    // which AC-14 forbids. So the fixture does distinguish the removal from a reintroduction of it.
    const retiredSelection = (out: WithLegacyPushedHead): string | undefined => out.pushedHead ?? LOCAL_HEAD;
    const stub: WithLegacyPushedHead = {
      outcome: "ready",
      url: URL,
      ci: "green",
      reasons: [],
      pushedHead: LEGACY_PUSHED,
    };
    const h = stepHarness(stub);
    await publishStep(h.env, h.env.record);
    expect(retiredSelection(stub)).toBe(LEGACY_PUSHED);
    expect(h.inputs[0]?.head).toBe(LOCAL_HEAD);
    expect(retiredSelection(stub)).not.toBe(h.inputs[0]?.head);
  });

  test("the CI-repair read is handed that same local HEAD, not the retired pushed head", async () => {
    const stub: WithLegacyPushedHead = {
      outcome: "draft",
      url: URL,
      ci: "failed",
      reasons: ["CI failed"],
      pushedHead: LEGACY_PUSHED,
    };
    const base = makeFeatureMachineHarness(
      { published: stub, ciFailures: [{ name: "unit", excerpt: "1 failing", url: "https://gh/run/1" }] },
      { stories: [makeDoneStory("S1")] },
    );
    const env: FeatureEnv = { ...base.env, steps: { ...base.env.steps, head: async () => LOCAL_HEAD } };
    const out = await publishStep(env, env.record);
    expect(base.ciFailureInputs).toEqual([{ url: URL, head: LOCAL_HEAD }]);
    expect(out.exit).toBe("ci-repair");
  });
});
