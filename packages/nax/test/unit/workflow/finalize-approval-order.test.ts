/**
 * US-001 (nax#2666): the workflow approval advisor is asked before the single ledger commit and the
 * push, not after the CI wait. The advisor writes `advise` into the same call log `wireFinalize`
 * records, so the order of the whole publish round is one sequence a test can read.
 *
 * The only facts a ruling needs are already known before the push (`plan.base` holds no CI reason),
 * so a green CI no longer has to be observed to ask, and a red or pending one only keeps the draft.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeFeatureContext, makeFinalizeAdvisor, wireFinalize } from "@test/helpers";
import type { AdviceDecision, Advisor, QuestionDraft } from "@/advisor";
import { _featureDeps } from "@/workflow/feature-deps";
import { newFeatureRecord } from "@/workflow/feature-record";
import { type PublishInput, type PublishOutcome, publish } from "@/workflow/finalize";
import { _workflowDeps } from "@/workflow/step-context";
import type { StorySummary } from "@/workflow/types";

const originalFeature = { ..._featureDeps };
const originalWorkflow = { ..._workflowDeps };
afterEach(() => {
  Object.assign(_featureDeps, originalFeature);
  Object.assign(_workflowDeps, originalWorkflow);
});

const DONE: StorySummary = {
  id: "US-001",
  title: "A",
  state: "complete",
  rounds: 1,
  unreviewed: false,
  flagged: 0,
};
/** A story whose gate never closed: a deterministic reason, so the advisor is never asked. */
const GATE_OPEN: StorySummary = { ...DONE, state: "complete-gate-open" };

/** The decision under test's own id, so an AC can name the ruling the advisor wrote. */
function withId(decision: AdviceDecision, id: string | undefined): AdviceDecision {
  return id === undefined ? decision : { ...decision, id };
}

interface HarnessOptions {
  /** The CI state the CI wait reports. */
  readonly ci?: "green" | "failed" | "pending";
  /** The advisor's ruling: an approval (the default) or a hold. */
  readonly approve?: boolean;
  /** The id the advisor's ruling carries. */
  readonly decisionId?: string;
  readonly stories?: readonly StorySummary[];
}

/**
 * One publish round over the `wireFinalize` harness, with the advisor inside the call log. Both the
 * question the advisor was sent and the ledger its ruling lands in are kept, so a test can assert
 * what the advisor saw and what the draft body could read afterwards.
 */
function harness(opts: HarnessOptions = {}) {
  const calls = wireFinalize({ ci: opts.ci ?? "green" });
  // The ledger as the advisor leaves it: empty until `advise` writes its decision, so a reader before
  // the advice sees [] and a reader after it sees the decision.
  const ledger: AdviceDecision[] = [];
  _workflowDeps.readTrustedDecisions = async () => [...ledger];
  const asked: QuestionDraft[] = [];
  const base = makeFinalizeAdvisor(opts.approve ?? true);
  const advisor: Advisor = {
    ...base,
    advise: async (question) => {
      asked.push(question);
      calls.push({ name: "advise" });
      const answer = await base.advise(question);
      const decision = answer.decision === null ? null : withId(answer.decision, opts.decisionId);
      if (decision) ledger.push(decision);
      return { ...answer, decision };
    },
  };
  const input: PublishInput = {
    record: {
      ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      reviewRan: true,
      finalGates: { ran: ["test"], failing: [] },
    },
    stories: opts.stories ?? [DONE],
    flagged: 0,
    advisor,
    preflight: null,
  };
  return {
    asked,
    names: (): string[] => calls.map((call) => call.name),
    ledgerCalls: (): number => calls.filter((call) => call.name === "ledger").length,
    promote: () => calls.find((call) => call.name === "promote"),
    /** The body one forge call carried: the draft (`openDraftFinishPr`) or the promoted PR. */
    body: (name: string): string => String(calls.find((call) => call.name === name)?.arg),
    run: (): Promise<PublishOutcome> => publish(makeFeatureContext(), input),
  };
}

/** The lines under `## Advisor decisions`, or `MISSING` when the body has no such section. */
function advisorSection(body: string): string {
  return body.split("## Advisor decisions\n\n")[1]?.split("\n\n## ")[0] ?? "MISSING";
}

describe("publish asks the approval advisor before the push (US-001)", () => {
  test("AC-1: the ruling precedes the single ledger commit, the push, the draft and the CI wait", async () => {
    const h = harness({ ci: "green" });
    await h.run();
    expect(h.names()).toEqual(["advise", "ledger", "push", "draft", "ci", "promote"]);
  });

  test("AC-2/3/4: an approving advisor and a green CI make the PR ready, with no reasons", async () => {
    const h = harness({ ci: "green" });
    const out = await h.run();
    expect(out.outcome).toBe("ready");
    expect(out.reasons).toEqual([]);
    expect(h.promote()?.keepDraft).toBe(false);
  });

  test("AC-5: the advisor's line rides the one and only ledger commit", async () => {
    const h = harness({ ci: "green" });
    await h.run();
    expect(h.ledgerCalls()).toBe(1);
  });

  test("AC-6/7/8: a red CI after the approval keeps the draft, cites CI and keeps the ruling", async () => {
    const h = harness({ ci: "failed" });
    const out = await h.run();
    expect(out.outcome).toBe("draft");
    expect(out.reasons).toEqual(["CI failed"]);
    // An approval that CI contradicted adds no reason of its own.
    expect(out.approval).toEqual({ approved: true, rationale: "clean", decisionId: "D-1" });
  });

  test("AC-9: a pending CI keeps the draft even though the advisor approved", async () => {
    const h = harness({ ci: "pending" });
    await h.run();
    expect(h.promote()?.keepDraft).toBe(true);
  });

  test("AC-10/11: a hold taken before the push keeps the draft and adds its rationale", async () => {
    const h = harness({ ci: "green", approve: false });
    const out = await h.run();
    expect(out.outcome).toBe("draft");
    expect(out.reasons).toEqual(["advisor held: risky"]);
    // A held advisor still pushes, so CI runs and the draft shows its state.
    expect(h.names()).toContain("push");
  });

  test("AC-12/13: a deterministic reason never asks the advisor, and still pushes, drafts and waits", async () => {
    const h = harness({ ci: "green", stories: [GATE_OPEN] });
    const out = await h.run();
    expect(h.asked).toEqual([]);
    expect(h.names()).toEqual(["ledger", "push", "draft", "ci", "promote"]);
    expect(out.reasons).toEqual(["stories gate-open: US-001"]);
  });

  test("AC-14: the draft body already cites the decision the advisor just wrote", async () => {
    const h = harness({ ci: "green", decisionId: "D-3" });
    await h.run();
    expect(advisorSection(h.body("draft"))).toContain("D-3");
  });
});
