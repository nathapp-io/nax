/**
 * US-002 AC-1…AC-16, AC-21: the no-work ladder, driven through `runStoryLoop`.
 *
 * The ladder itself (src/workflow/no-work.ts) is small, but every one of its branches is a
 * decision about the loop — which turn comes next, whether the gates run at all, what the record
 * ends with — so each test drives the loop and reads the turns it was handed.
 */
import { describe, expect, test } from "bun:test";
import { defaultWorkflowAdvisor, type WorkflowAdvisor } from "@/workflow/advisor";
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
const pass: StoryReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
};

const NO_WORK_NOTE = "no work: reply carried no status block, no changes since the story base, no report";
const AFTER_WARM_NOTE = "no work after the restart: restarting fresh one tier up";
const AFTER_FRESH_NOTE = "no work after the fresh restart: closing the story without review";

const WARM_RESTART: ImplementTurn = { kind: "restart", fresh: false, stepUps: 0 };
const FRESH_RESTART: ImplementTurn = { kind: "restart", fresh: true, stepUps: 1 };

/** The parser's US-001 no-work signal: a reply with no status block at all. */
const noWorkTurn: ImplementOutcome = {
  reply: {
    status: "DONE_WITH_CONCERNS",
    commits: [],
    testSummary: "",
    concerns: "implementer reply carried no status block",
    interrupted: false,
    noStatusBlock: true,
  },
  autoCommitted: false,
};
const doneTurn: ImplementOutcome = {
  reply: { status: "DONE", commits: ["abc"], testSummary: "bun test: 3 pass", interrupted: false },
  autoCommitted: false,
};
const needsContextTurn: ImplementOutcome = {
  reply: { status: "NEEDS_CONTEXT", commits: [], testSummary: "", concerns: "which API?", interrupted: false },
  autoCommitted: false,
};
const interruptedTurn: ImplementOutcome = {
  reply: {
    status: "DONE_WITH_CONCERNS",
    commits: [],
    testSummary: "",
    concerns: "step time limit reached",
    interrupted: true,
  },
  autoCommitted: false,
};

type RestartTurn = Extract<ImplementTurn, { kind: "restart" }>;
type AnswerTurn = Extract<ImplementTurn, { kind: "answer" }>;

const restarts = (turns: readonly ImplementTurn[]): RestartTurn[] =>
  turns.filter((t): t is RestartTurn => t.kind === "restart");
const answers = (turns: readonly ImplementTurn[]): AnswerTurn[] =>
  turns.filter((t): t is AnswerTurn => t.kind === "answer");

interface HarnessOptions {
  /** The nth implement call's outcome (1-based); the last entry repeats. Default: one DONE turn. */
  outcomes?: ImplementOutcome[];
  /** Successive `steps.workProduced` answers; the last repeats. Omitted leaves the step absent. */
  work?: boolean[] | "throws";
  advisor?: WorkflowAdvisor;
  resume?: WorkflowStoryRecord;
  maxFixRounds?: number;
}

/** The faked work-evidence step, with the call counter the AC-15 assertion reads. */
function workStep(work: HarnessOptions["work"], counter: { calls: number }): (() => Promise<boolean>) | undefined {
  if (work === undefined) return undefined;
  const answers = work === "throws" ? [] : work;
  return async () => {
    counter.calls += 1;
    if (work === "throws") throw new Error("git status failed");
    return answers[Math.min(counter.calls - 1, answers.length - 1)] ?? false;
  };
}

function harness(opts: HarnessOptions = {}) {
  const outcomes = opts.outcomes ?? [doneTurn];
  const turns: ImplementTurn[] = [];
  const ledger: string[] = [];
  const updates: Partial<WorkflowStoryRecord>[] = [];
  /** Turns and steps interleaved in call order — how "before steps.gates" is asserted. */
  const events: string[] = [];
  /** Every gates / story-review / full-suite call, so "none of them ran" is one assertion. */
  const gateSteps: string[] = [];
  /** The concerns list each story-review call received. */
  const reviews: (readonly string[])[] = [];
  const workCounter = { calls: 0 };
  let implementCalls = 0;
  let record: WorkflowStoryRecord = newStoryRecord("US-001", opts.maxFixRounds ?? 5, "t");
  const steps: StoryLoopSteps = {
    implement: async (turn) => {
      implementCalls += 1;
      turns.push(turn);
      events.push(`turn:${turn.kind}${turn.kind === "restart" && turn.fresh ? "-fresh" : ""}`);
      return outcomes[Math.min(implementCalls - 1, outcomes.length - 1)] ?? doneTurn;
    },
    gates: async () => {
      gateSteps.push("gates");
      events.push("gates");
      return GREEN;
    },
    fullSuite: async () => {
      gateSteps.push("full-suite");
      events.push("full-suite");
      return SUITE_GREEN;
    },
    storyReview: async (concerns) => {
      gateSteps.push("story-review");
      reviews.push(concerns);
      return { ran: true, verdict: pass };
    },
    reReview: async (_round, findings) => ({
      ran: true,
      verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] },
    }),
    head: async () => "h1",
    uncommitted: async () => [],
    costExceeded: () => false,
  };
  const producedWork = workStep(opts.work, workCounter);
  if (producedWork) steps.workProduced = producedWork;
  const env: StoryLoopEnv = {
    storyId: "US-001",
    maxFixRounds: opts.maxFixRounds ?? 5,
    steps,
    advisor: opts.advisor ?? defaultWorkflowAdvisor,
    sink: {
      update: async (patch) => {
        updates.push(patch);
        record = { ...record, ...patch };
      },
      ledger: async (text) => {
        ledger.push(text);
        events.push(`ledger:${text}`);
      },
    },
    resume: opts.resume ?? null,
  };
  return {
    env,
    turns,
    ledger,
    updates,
    events,
    gateSteps,
    reviews,
    record: () => record,
    workCalls: () => workCounter.calls,
  };
}

describe("no-work ladder (US-002)", () => {
  test("AC-1: a no-work first turn gets a warm restart before the gates", async () => {
    const h = harness({ outcomes: [noWorkTurn, noWorkTurn, doneTurn], work: [false, false, true] });
    await runStoryLoop(h.env);
    expect(h.turns[1]).toEqual(WARM_RESTART);
    expect(h.events.indexOf("turn:restart")).toBeLessThan(h.events.indexOf("gates"));
  });

  test("AC-2: the no-work ledger line precedes the warm restart turn", async () => {
    const h = harness({ outcomes: [noWorkTurn, doneTurn], work: [false, true] });
    await runStoryLoop(h.env);
    expect(h.ledger).toContain(NO_WORK_NOTE);
    expect(h.events.indexOf(`ledger:${NO_WORK_NOTE}`)).toBeLessThan(h.events.indexOf("turn:restart"));
  });

  test("AC-3: a no-work warm restart is followed by a fresh restart one tier up", async () => {
    const h = harness({ outcomes: [noWorkTurn, noWorkTurn, doneTurn], work: [false, false, true] });
    await runStoryLoop(h.env);
    expect(h.turns[2]).toEqual(FRESH_RESTART);
    expect(h.events.indexOf(`ledger:${AFTER_WARM_NOTE}`)).toBeLessThan(h.events.indexOf("turn:restart-fresh"));
  });

  test("AC-4: a no-work fresh restart closes the story gate-open", async () => {
    const h = harness({ outcomes: [noWorkTurn], work: [false] });
    const out = await runStoryLoop(h.env);
    expect(out).toMatchObject({ state: "complete-gate-open", reason: "no work produced" });
    expect(h.turns).toEqual([{ kind: "implement" }, WARM_RESTART, FRESH_RESTART]);
  });

  test("AC-5: three no-work turns spend no gate, no review and no suite", async () => {
    const h = harness({ outcomes: [noWorkTurn], work: [false] });
    await runStoryLoop(h.env);
    expect(h.gateSteps).toEqual([]);
  });

  test("AC-6: the closing line says the story closed without review", async () => {
    const h = harness({ outcomes: [noWorkTurn], work: [false] });
    await runStoryLoop(h.env);
    expect(h.ledger).toContain(AFTER_FRESH_NOTE);
  });

  test("AC-7: the last record update closes the story with the no-work reason", async () => {
    const h = harness({ outcomes: [noWorkTurn], work: [false] });
    await runStoryLoop(h.env);
    expect(h.updates.at(-1)).toMatchObject({
      state: "complete-gate-open",
      reason: "no work produced",
      phase: "closed",
    });
    expect(h.record().state).toBe("complete-gate-open");
  });

  test("AC-8: work from the warm restart goes on to the gates, with no fresh restart", async () => {
    const h = harness({ outcomes: [noWorkTurn, doneTurn], work: [false, true] });
    await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([WARM_RESTART]);
    expect(h.events.indexOf("gates")).toBeGreaterThan(h.events.indexOf("turn:restart"));
  });

  test("AC-9: a no-status reply with work evidence is not a no-work turn", async () => {
    const h = harness({ outcomes: [noWorkTurn, doneTurn], work: [true] });
    await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([]);
    expect(h.turns).toEqual([{ kind: "implement" }]);
    expect(h.gateSteps).toContain("gates");
  });

  test("AC-10: a DONE reply is not a no-work turn even with no work evidence", async () => {
    const h = harness({ outcomes: [doneTurn], work: [false] });
    await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([]);
    expect(h.gateSteps).toContain("gates");
  });

  test("AC-11: with no workProduced step a no-status reply is not a no-work turn", async () => {
    const h = harness({ outcomes: [noWorkTurn, doneTurn] });
    await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([]);
    expect(h.gateSteps).toContain("gates");
  });

  test("AC-12: a throwing workProduced step fails open — no restart, gates still run", async () => {
    const h = harness({ outcomes: [noWorkTurn, doneTurn], work: "throws" });
    await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([]);
    expect(h.gateSteps).toContain("gates");
  });

  test("AC-13: a failed warm restart ends the ladder and the gates still run", async () => {
    const h = harness({
      outcomes: [noWorkTurn, { failure: "boom", autoCommitted: false }, doneTurn],
      work: [false, true],
    });
    await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([WARM_RESTART]);
    expect(h.gateSteps).toContain("gates");
  });

  test("AC-14: a cost-stopped story restarts nothing and closes cost-limit", async () => {
    const h = harness({ outcomes: [noWorkTurn], work: [false] });
    h.env.steps.costExceeded = () => true;
    const out = await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([]);
    expect(out.reason).toBe("cost-limit");
  });

  test("the cost check runs before each restart, so an exceeded budget stops the fresh one", async () => {
    const h = harness({ outcomes: [noWorkTurn, noWorkTurn, doneTurn], work: [false, false, true] });
    let calls = 0;
    h.env.steps.costExceeded = () => ++calls > 1;
    const out = await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([WARM_RESTART]);
    expect(out.reason).toBe("cost-limit");
  });

  test("AC-15: a resumed story never asks whether work was produced", async () => {
    const prior: WorkflowStoryRecord = {
      ...newStoryRecord("US-001", 5, "t"),
      round: 1,
      phase: "rereview",
      reviewed: true,
      openFindings: [{ id: "F2", kind: "spec", severity: "important", issue: "gap" }],
      nextFindingId: 3,
    };
    const h = harness({ resume: prior, work: [true] });
    await runStoryLoop(h.env);
    expect(h.workCalls()).toBe(0);
  });

  test("AC-16: an advisor answer to the fresh restart runs on the stepped-up model", async () => {
    const h = harness({
      outcomes: [noWorkTurn, noWorkTurn, needsContextTurn, doneTurn],
      work: [false, false, true],
      advisor: { ...defaultWorkflowAdvisor, answerQuestion: async () => "try X" },
    });
    await runStoryLoop(h.env);
    expect(answers(h.turns)).toEqual([{ kind: "answer", text: "try X", stepUps: 1, limit: "implement" }]);
  });

  test("AC-21 (US-007 AC-14…AC-16): an interrupted restart continues once and the gates run on the fallback concern", async () => {
    const h = harness({ outcomes: [noWorkTurn, interruptedTurn], work: [false, true] });
    await runStoryLoop(h.env);
    expect(restarts(h.turns)).toEqual([WARM_RESTART]);
    // AC-14: the harness repeats `interruptedTurn`, so exactly one continue follows the warm restart.
    expect(h.turns.filter((turn) => turn.kind === "continue")).toHaveLength(1);
    expect(h.events.indexOf("turn:continue")).toBeGreaterThan(h.events.indexOf("turn:restart"));
    // AC-15: the gates run after that continue.
    expect(h.events.indexOf("gates")).toBeGreaterThan(h.events.indexOf("turn:continue"));
    // AC-16: the fallback concern replaces the raw step-limit one the reply carried.
    const concern = h.reviews.at(-1)?.[0] ?? "";
    expect(concern).toContain("stopped at the step limit after 1 continue attempt(s)");
    expect(concern).not.toContain("DONE_WITH_CONCERNS: step time limit reached");
  });
});
