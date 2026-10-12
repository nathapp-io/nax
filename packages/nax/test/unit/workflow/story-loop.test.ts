import { describe, expect, test } from "bun:test";
import { defaultWorkflowAdvisor } from "@/workflow/advisor";
import type { ImplementOutcome, ImplementTurn } from "@/workflow/implement";
import { newStoryRecord } from "@/workflow/result";
import { runStoryLoop, type StoryLoopEnv, type StoryLoopSteps } from "@/workflow/story-loop";
import type { GateRunResult, StoryReviewVerdict, WorkflowStoryRecord } from "@/workflow/types";

const GREEN: GateRunResult = {
  red: false,
  states: { lint: "green", typecheck: "green", scoped: "green" },
  findings: [],
};
const SUITE_GREEN: GateRunResult = { red: false, states: { "full-suite": "green" }, findings: [] };
const SUITE_RED: GateRunResult = {
  red: true,
  states: { "full-suite": "red" },
  findings: [{ kind: "gate", gate: "full-suite", severity: "important", issue: "test x failed" }],
};
const RED_LINT: GateRunResult = {
  red: true,
  states: { lint: "red" },
  findings: [{ kind: "gate", gate: "lint", severity: "important", issue: "no-var" }],
};
const ok = {
  reply: { status: "DONE" as const, commits: [], testSummary: "", interrupted: false },
  autoCommitted: false,
};
const pass: StoryReviewVerdict = { spec: "pass", quality: "approved", findings: [], cannotVerify: [] };
const failing = (n = 1): StoryReviewVerdict => ({
  spec: "fail",
  quality: "changes",
  findings: Array.from({ length: n }, (_, i) => ({
    kind: "spec" as const,
    severity: "important" as const,
    issue: `gap ${i}`,
  })),
  cannotVerify: [],
});

interface Script {
  gates?: GateRunResult[];
  suite?: GateRunResult[];
  review?: (StoryReviewVerdict | null)[];
  reReviewAllAddressed?: boolean[];
  implement?: (turn: ImplementTurn) => ImplementOutcome;
}

function harness(script: Script, over: Partial<StoryLoopEnv> = {}) {
  const turns: ImplementTurn[] = [];
  const ledger: string[] = [];
  let record: WorkflowStoryRecord = newStoryRecord("US-001", over.maxFixRounds ?? 5, "t");
  const gates = [...(script.gates ?? [])];
  const suites = [...(script.suite ?? [])];
  const reviews = [...(script.review ?? [])];
  const reReviews = [...(script.reReviewAllAddressed ?? [])];
  let headN = 0;
  const steps: StoryLoopSteps = {
    implement: async (turn) => {
      turns.push(turn);
      return script.implement ? script.implement(turn) : ok;
    },
    gates: async () => gates.shift() ?? GREEN,
    fullSuite: async () => suites.shift() ?? SUITE_GREEN,
    storyReview: async () => {
      const v = reviews.length > 0 ? reviews.shift() : pass;
      return v === null || v === undefined ? { ran: false, why: "unparseable reply" } : { ran: true, verdict: v };
    },
    reReview: async (_round, findings) => {
      const all = reReviews.shift() ?? true;
      return {
        ran: true,
        verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: all, note: "" })), newFindings: [] },
      };
    },
    head: async () => `h${++headN}`,
    uncommitted: async () => [],
    costExceeded: () => false,
  };
  const env: StoryLoopEnv = {
    storyId: "US-001",
    maxFixRounds: 5,
    steps,
    advisor: defaultWorkflowAdvisor,
    sink: {
      update: async (patch) => {
        record = { ...record, ...patch };
      },
      ledger: async (t) => {
        ledger.push(t);
      },
    },
    resume: null,
    ...over,
  };
  return { env, turns, ledger, record: () => record };
}

const fixTurns = (turns: ImplementTurn[]) =>
  turns.filter((t): t is Extract<ImplementTurn, { kind: "fix" }> => t.kind === "fix");

describe("runStoryLoop", () => {
  test("clean story: implement, gates, review, suite -> complete, 0 rounds", async () => {
    const h = harness({});
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete", rounds: 0 });
    expect(h.turns).toEqual([{ kind: "implement" }]);
    expect(h.ledger.at(-1)).toStartWith("complete (0 round(s)");
    expect(h.record().state).toBe("complete");
  });

  test("red gate goes to a fix round with no review spent", async () => {
    let reviews = 0;
    const h = harness({ gates: [RED_LINT, GREEN] });
    const original = h.env.steps.storyReview;
    h.env.steps.storyReview = async (c) => {
      reviews++;
      return original(c);
    };
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(1);
    expect(reviews).toBe(1); // only after the gate went green
    expect(fixTurns(h.turns)[0]?.findings.map((f) => f.kind)).toEqual(["gate"]);
  });

  test("review findings -> warm fix -> re-review addressed -> complete", async () => {
    const h = harness({ review: [failing(2)], reReviewAllAddressed: [true] });
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete", rounds: 1 });
    const fix = fixTurns(h.turns)[0];
    expect(fix?.fresh).toBe(false);
    expect(fix?.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
    expect(h.ledger).toContain("fix round 1/5 (2 open: F1, F2)");
  });

  test("minors are deferred and never start a round", async () => {
    const h = harness({
      review: [
        {
          spec: "pass",
          quality: "approved",
          findings: [{ kind: "quality", severity: "minor", issue: "nit" }],
          cannotVerify: [],
        },
      ],
    });
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(0);
    expect(h.ledger).toContain("deferred-minor: nit");
  });

  test.each([
    [1, [false], 1],
    [3, [false, false, false], 3],
    [5, [false, false, false, true, true], 5],
  ])("maxFixRounds=%d: fresh flags %j, then residual (Review Focus 4)", async (max, freshFlags, rounds) => {
    const h = harness({ review: [failing()], reReviewAllAddressed: Array(max).fill(false) }, { maxFixRounds: max });
    const out = await runStoryLoop(h.env);
    expect(fixTurns(h.turns).map((t) => t.fresh)).toEqual(freshFlags);
    expect(fixTurns(h.turns).map((t) => t.stepUps)).toEqual(
      freshFlags.map((_, i) => Math.max(0, i + 1 - Math.min(3, max))),
    );
    expect(out).toMatchObject({ state: "complete-with-rulings", rounds });
    expect(h.ledger.some((l) => l.startsWith("Ruling: hold F1"))).toBe(true);
  });

  test("full suite red with rounds left loops; red at the cap -> gate-open", async () => {
    const h = harness({ suite: [SUITE_RED, SUITE_RED] }, { maxFixRounds: 1 });
    const out = await runStoryLoop(h.env);
    expect(out.state).toBe("complete-gate-open");
    expect(out.reason).toBe("red: full-suite");
    expect(fixTurns(h.turns)).toHaveLength(1);
  });

  test("residual at the cap with green gates runs the suite once for the record", async () => {
    let suiteRuns = 0;
    const h = harness({ review: [failing()], reReviewAllAddressed: [false] }, { maxFixRounds: 1 });
    h.env.steps.fullSuite = async () => {
      suiteRuns++;
      return SUITE_GREEN;
    };
    await runStoryLoop(h.env);
    expect(suiteRuns).toBe(1);
  });

  test("unparseable story review -> review-skipped, unreviewed, story proceeds", async () => {
    const h = harness({ review: [null] });
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete", unreviewed: true });
    expect(h.ledger).toContain("review-skipped (story review: unparseable reply)");
  });

  test("implementer session failure -> synthetic finding in the next fix round", async () => {
    let first = true;
    const h = harness({
      implement: (turn) => {
        if (turn.kind === "implement" && first) {
          first = false;
          return { failure: "auth expired", autoCommitted: false };
        }
        return ok;
      },
    });
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(1);
    expect(fixTurns(h.turns)[0]?.findings[0]).toMatchObject({
      kind: "session",
      issue: "implementer session failed: auth expired",
    });
  });

  test("NEEDS_CONTEXT with the stub advisor: no answer turn, concern reaches the review", async () => {
    let concernsSeen: readonly string[] = [];
    const h = harness({
      implement: () => ({
        reply: { status: "NEEDS_CONTEXT", commits: [], testSummary: "", concerns: "Which DB?", interrupted: false },
        autoCommitted: false,
      }),
    });
    h.env.steps.storyReview = async (c) => {
      concernsSeen = c;
      return { ran: true, verdict: pass };
    };
    await runStoryLoop(h.env);
    expect(h.turns.filter((t) => t.kind === "answer")).toHaveLength(0);
    expect(concernsSeen).toEqual(["NEEDS_CONTEXT: Which DB?"]);
  });

  test("an advisor answer becomes an answer turn, at most twice", async () => {
    const h = harness({
      implement: () => ({
        reply: { status: "BLOCKED", commits: [], testSummary: "", concerns: "stuck", interrupted: false },
        autoCommitted: false,
      }),
    });
    const advisor = { ...defaultWorkflowAdvisor, answerQuestion: async () => "try X" };
    await runStoryLoop({ ...h.env, advisor });
    expect(h.turns.filter((t) => t.kind === "answer")).toEqual([
      { kind: "answer", text: "try X" },
      { kind: "answer", text: "try X" },
    ]);
  });

  test("cost limit mid-story stops at the next step -> gate-open cost-limit", async () => {
    const h = harness({ review: [failing()] });
    let calls = 0;
    h.env.steps.costExceeded = () => ++calls > 1;
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete-gate-open", reason: "cost-limit" });
  });

  test("resume (Review Focus 5): no implement, first round fresh on the same tier, ids continue", async () => {
    const prior: WorkflowStoryRecord = {
      ...newStoryRecord("US-001", 5, "t"),
      round: 1,
      phase: "rereview",
      reviewed: true,
      openFindings: [{ id: "F2", kind: "spec", severity: "important", issue: "gap" }],
      nextFindingId: 3,
    };
    const h = harness({ reReviewAllAddressed: [false, true] }, { resume: prior });
    const out = await runStoryLoop(h.env);
    expect(h.turns[0]).toMatchObject({ kind: "fix", round: 2, fresh: true, stepUps: 0 });
    expect(h.turns.some((t) => t.kind === "implement")).toBe(false);
    expect(fixTurns(h.turns)[1]).toMatchObject({ round: 3, fresh: false });
    expect(out.rounds).toBe(3);
  });

  test("fixBase: taken once per fix cycle, kept across a red-gate round, retaken after a re-review", async () => {
    const h = harness({ gates: [GREEN, RED_LINT, GREEN, GREEN], review: [failing()] });
    const headCalls: string[] = [];
    const reReviewBases: string[] = [];
    const originalHead = h.env.steps.head;
    const originalReReview = h.env.steps.reReview;
    h.env.steps.head = async () => {
      const value = await originalHead();
      headCalls.push(value);
      return value;
    };
    let n = 0;
    h.env.steps.reReview = async (round, findings, fixBase) => {
      reReviewBases.push(fixBase);
      n++;
      if (n === 1) {
        return {
          ran: true,
          verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: false, note: "" })), newFindings: [] },
        };
      }
      return originalReReview(round, findings, fixBase);
    };
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete", rounds: 3 });
    // round 1 takes h1; round 2 (red gate, review finding still open) reuses it; round 3 retakes h2 after the re-review
    expect(headCalls).toEqual(["h1", "h2"]);
    expect(reReviewBases).toEqual(["h1", "h2"]);
  });

  test("new breakage from a re-review joins the open list with a fresh id", async () => {
    const h = harness({ review: [failing()] });
    let n = 0;
    h.env.steps.reReview = async (_r, findings) => {
      n++;
      return n === 1
        ? {
            ran: true,
            verdict: {
              verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })),
              newFindings: [{ kind: "quality", severity: "critical", issue: "broke parse" }],
            },
          }
        : {
            ran: true,
            verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] },
          };
    };
    const out = await runStoryLoop(h.env);
    expect(fixTurns(h.turns)[1]?.findings.map((f) => f.id)).toEqual(["F2"]);
    expect(out.state).toBe("complete");
  });
});
