import { describe, expect, test } from "bun:test";
import { defaultWorkflowAdvisor } from "@/workflow/advisor";
import type { ImplementOutcome, ImplementTurn } from "@/workflow/implement";
import { newStoryRecord } from "@/workflow/result";
import { runStoryLoop, type StoryLoopEnv, type StoryLoopSteps, turnLabel } from "@/workflow/story-loop";
import type { GateName, GateRunResult, GateState, StoryReviewVerdict, WorkflowStoryRecord } from "@/workflow/types";

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
const pass: StoryReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
};
const failing = (n = 1): StoryReviewVerdict => ({
  spec: "fail",
  quality: "changes",
  findings: Array.from({ length: n }, (_, i) => ({
    kind: "spec" as const,
    severity: "important" as const,
    issue: `gap ${i}`,
  })),
  cannotVerify: [],
  inspectedFiles: [],
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
  const reviewGates: (Readonly<Partial<Record<GateName, GateState>>> | undefined)[] = [];
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
    storyReview: async (_concerns, gateStates) => {
      reviewGates.push(gateStates);
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
  return { env, turns, ledger, reviewGates, record: () => record };
}

const fixTurns = (turns: ImplementTurn[]) =>
  turns.filter((t): t is Extract<ImplementTurn, { kind: "fix" }> => t.kind === "fix");

describe("answer turns", () => {
  const answering = { ...defaultWorkflowAdvisor, answerQuestion: async () => "try X" };
  const needsContext: ImplementOutcome = {
    reply: { status: "NEEDS_CONTEXT", commits: [], testSummary: "", interrupted: false, concerns: "which API?" },
    autoCommitted: false,
  };
  const answers = (turns: ImplementTurn[]) => turns.filter((t) => t.kind === "answer");

  test("answer to the first implement turn carries stepUps 0 and the implement limit", async () => {
    const h = harness({ implement: (t) => (t.kind === "implement" ? needsContext : ok) }, { advisor: answering });
    await runStoryLoop(h.env);
    expect(answers(h.turns)).toEqual([{ kind: "answer", text: "try X", stepUps: 0, limit: "implement" }]);
  });

  test("answer to a fresh round-4 fix turn carries that round's stepUps and the fix limit", async () => {
    const h = harness(
      {
        review: [failing(), failing(), failing(), failing(), pass],
        reReviewAllAddressed: [false, false, false, true],
        implement: (t) => (t.kind === "fix" && t.round === 4 ? needsContext : ok),
      },
      { advisor: answering, maxFixRounds: 5 },
    );
    await runStoryLoop(h.env);
    const round4 = fixTurns(h.turns).find((t) => t.round === 4);
    expect(round4?.fresh).toBe(true);
    expect(round4?.stepUps).toBe(1);
    expect(answers(h.turns)).toEqual([{ kind: "answer", text: "try X", stepUps: 1, limit: "fix" }]);
  });
});

describe("runStoryLoop", () => {
  test("clean story: implement, gates, suite, review -> complete, 0 rounds", async () => {
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
          inspectedFiles: [],
        },
      ],
    });
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(0);
    expect(h.ledger).toContain("deferred-minor: nit");
  });

  // A story reviewer that says only "nax runs the suite later" adds an item nax-finish must rule on;
  // nax records whether the suite ran, so the line is noted, never ledgered as cannot-verify.
  test("a gate-timing cannotVerify line is noted as dropped; a real one is kept", async () => {
    const h = harness({
      review: [
        {
          ...pass,
          cannotVerify: ["Full test suite (nax runs it after review; not yet reached)", "needs the live payments API"],
        },
      ],
    });
    await runStoryLoop(h.env);
    expect(h.ledger).toContain("cannot-verify: needs the live payments API");
    expect(h.ledger).toContain(
      "cannot-verify dropped (a nax gate covers it): Full test suite (nax runs it after review; not yet reached)",
    );
    expect(h.ledger.filter((l) => l.startsWith("cannot-verify: "))).toHaveLength(1);
  });

  // The concern text reached only the story-review prompt; the ledger kept no trace of it.
  test("an implementer DONE_WITH_CONCERNS lands in the ledger with its text", async () => {
    const h = harness({
      implement: () => ({
        reply: {
          status: "DONE_WITH_CONCERNS",
          commits: [],
          testSummary: "",
          concerns: "deleted AC5 and AC7 tests the brief said to keep",
          interrupted: false,
        },
        autoCommitted: false,
      }),
    });
    await runStoryLoop(h.env);
    expect(h.ledger).toContain("implementer DONE_WITH_CONCERNS: deleted AC5 and AC7 tests the brief said to keep");
  });

  test("a plain DONE writes no implementer concern note", async () => {
    const h = harness({});
    await runStoryLoop(h.env);
    expect(h.ledger.some((l) => l.startsWith("implementer "))).toBe(false);
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

  test("residual at the cap skips the suite already run in the last pass", async () => {
    let suiteRuns = 0;
    const h = harness({ review: [failing()], reReviewAllAddressed: [false] }, { maxFixRounds: 1 });
    h.env.steps.fullSuite = async () => {
      suiteRuns++;
      return SUITE_GREEN;
    };
    await runStoryLoop(h.env);
    expect(suiteRuns).toBe(2);
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
      { kind: "answer", text: "try X", stepUps: 0, limit: "implement" },
      { kind: "answer", text: "try X", stepUps: 0, limit: "implement" },
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

  test("fixBase: a skipped re-review keeps it, so the next re-review covers both rounds' fixes", async () => {
    const h = harness({ review: [failing()] });
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
      if (n === 1) return { ran: false, why: "timeout" };
      return originalReReview(round, findings, fixBase);
    };
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete", rounds: 2 });
    // round 1 takes h1; its re-review is skipped, so round 2 keeps h1 rather than taking h2
    expect(headCalls).toEqual(["h1"]);
    expect(reReviewBases).toEqual(["h1", "h1"]);
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

  // US-004 (nax#2524): a PARTIAL verdict keeps F1 open under its own id with the residual as its issue.
  test("a PARTIAL re-review keeps F1 open with the residual as its issue (AC-16)", async () => {
    const h = harness({ review: [failing()] });
    let n = 0;
    h.env.steps.reReview = async (_round, findings) => {
      n++;
      return {
        ran: true,
        verdict: {
          verdicts: findings.map((f) => ({
            id: f.id,
            addressed: n > 1,
            note: "",
            ...(n === 1 ? { residual: { issue: "still open" } } : {}),
          })),
          newFindings: [],
        },
      };
    };
    const out = await runStoryLoop(h.env);
    const secondFix = fixTurns(h.turns)[1];
    expect(secondFix?.findings.map((f) => f.id)).toEqual(["F1"]);
    expect(secondFix?.findings[0]?.issue).toBe("still open");
    expect(out.state).toBe("complete");
  });

  test("a new finding that restates the residual is neither opened nor deferred (US-004)", async () => {
    const h = harness({
      review: [
        {
          spec: "fail",
          quality: "changes",
          findings: [{ kind: "spec", severity: "important", issue: "gap", file: "a.ts", line: 53 }],
          cannotVerify: [],
          inspectedFiles: [],
        },
      ],
    });
    let n = 0;
    h.env.steps.reReview = async (_round, findings) => {
      n++;
      return {
        ran: true,
        verdict: {
          verdicts: findings.map((f) => ({
            id: f.id,
            addressed: n > 1,
            note: "",
            ...(n === 1 ? { residual: { issue: "symlinks still bypass", file: "a.ts", line: 53 } } : {}),
          })),
          // the reviewer restates the residual at the same place, and adds one minor elsewhere
          newFindings:
            n === 1
              ? [
                  { kind: "spec", severity: "critical", issue: "symlinks still bypass", file: "a.ts", line: 53 },
                  { kind: "quality", severity: "minor", issue: "naming nit", file: "b.ts", line: 7 },
                ]
              : [],
        },
      };
    };
    const out = await runStoryLoop(h.env);
    const secondFix = fixTurns(h.turns)[1];
    expect(secondFix?.findings.map((f) => f.id)).toEqual(["F1"]);
    expect(secondFix?.findings[0]?.issue).toBe("symlinks still bypass");
    expect(h.ledger).toContain("deferred-minor: naming nit");
    expect(h.ledger.filter((l) => l.startsWith("deferred-minor:"))).toHaveLength(1);
    expect(h.record().deferredMinors).toBe(1);
    expect(out.state).toBe("complete");
  });
});

describe("story review gate context (US-006)", () => {
  test("the gate states the loop already recorded reach storyReview (AC-10)", async () => {
    const h = harness({});
    await runStoryLoop(h.env);
    expect(h.reviewGates[0]).toEqual({ lint: "green", typecheck: "green", scoped: "green", "full-suite": "green" });
  });
});

describe("flagged rulings at close", () => {
  test("a default hold at the cap counts as flagged on the record", async () => {
    const h = harness({ review: [failing()], reReviewAllAddressed: [false] }, { maxFixRounds: 1 });
    await runStoryLoop(h.env);
    expect(h.record().flagged).toBe(1);
  });

  test("a clean story has flagged 0", async () => {
    const h = harness({});
    await runStoryLoop(h.env);
    expect(h.record().flagged).toBe(0);
  });
});

describe("turnLabel (US-001)", () => {
  test("a warm restart, a fresh restart and an implement turn get three distinct labels", () => {
    const labels = [
      turnLabel({ kind: "implement" }),
      turnLabel({ kind: "restart", fresh: false, stepUps: 0 }),
      turnLabel({ kind: "restart", fresh: true, stepUps: 1 }),
    ];
    expect(new Set(labels).size).toBe(3);
    expect(labels[0]).toBe("implementer");
  });

  test("a restart label is neither the implement label nor a fix-round label", () => {
    for (const fresh of [true, false]) {
      const label = turnLabel({ kind: "restart", fresh, stepUps: 0 });
      expect(label).not.toBe("implementer");
      expect(label).not.toMatch(/^fix r\d+$/);
    }
  });
});

describe("turnLabel continue and report turns (US-004)", () => {
  test("a continue turn is labelled as the implementer continuing", () => {
    expect(turnLabel({ kind: "continue", limit: "implement", stepUps: 0, attempt: 1, maxAttempts: 1 })).toBe(
      "implementer continue",
    );
  });

  test("a report turn is labelled as the implementer reporting", () => {
    expect(turnLabel({ kind: "report", stepUps: 0 })).toBe("implementer report");
  });
});

describe("US-002 persisted fix base", () => {
  test("AC-4 persists before fix and clears after re-review", async () => {
    const h = harness({ review: [failing()] });
    h.env.steps.head = async () => "abc";
    const update = h.env.sink.update;
    h.env.sink.update = async (patch) => {
      if (h.record().fixBase && "fixBase" in patch && patch.fixBase === undefined) {
        expect(patch.openFindings).toEqual([]);
      }
      await update(patch);
    };
    const implement = h.env.steps.implement;
    h.env.steps.implement = async (turn) => {
      if (turn.kind === "fix") expect(h.record().fixBase).toBe("abc");
      return implement(turn);
    };
    await runStoryLoop(h.env);
    expect(fixTurns(h.turns)).toHaveLength(1);
    expect(h.record().fixBase).toBeUndefined();
  });
  test("AC-5 resumed fix is re-reviewed before a new fix", async () => {
    const h = harness(
      {},
      {
        resume: {
          ...newStoryRecord("US-001", 5, "t"),
          reviewed: true,
          round: 1,
          fixBase: "abc",
          openFindings: [{ id: "F1", kind: "spec", severity: "important", issue: "gap" }],
        },
      },
    );
    const calls: string[] = [];
    h.env.steps.reReview = async (_round, findings, base) => {
      calls.push(`review:${base}`);
      return {
        ran: true,
        verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] },
      };
    };
    h.env.steps.implement = async () => {
      calls.push("fix");
      return ok;
    };
    await runStoryLoop(h.env);
    expect(calls).toEqual(["review:abc"]);
  });
});
