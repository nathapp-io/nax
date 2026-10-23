/**
 * US-008 AC-1…AC-22: the report check (src/workflow/report-check.ts), driven through `runStoryLoop`.
 *
 * `runReportCheck` is one seam, but every branch of it is a decision about the loop — whether a turn
 * is spent at all, which turn it is, and what it runs on — so each test drives the loop with faked
 * steps and reads the turns, the ledger lines and the call order it produced. The fixture every AC
 * starts from: green gates, a story review that records when it was called, `costExceeded` false,
 * and a scripted `reportExists`.
 *
 * Spec: docs/specs/SPEC-workflow-interrupt-continue.md § US-008.
 */
import { describe, expect, test } from "bun:test";
import {
  failingReview,
  makeStoryLoopHarness,
  type StoryLoopHarness,
  type StoryLoopScript,
  storyLoopFixtures,
} from "@test/helpers";
import type { ImplementOutcome, ImplementTurn } from "@/workflow/implement";
import { newStoryRecord } from "@/workflow/result";
import { runStoryLoop, type StoryLoopSteps } from "@/workflow/story-loop";
import type { WorkflowStoryRecord } from "@/workflow/types";

const { GREEN, RED_LINT } = storyLoopFixtures;

const MISSING_NOTE = "report.md missing after the implementer's reply: asking the session to write it";
const WRITTEN_NOTE = "report turn: report written";
const STILL_MISSING_NOTE = "report turn: report still missing, reviewing without it";

const DONE: ImplementOutcome = {
  reply: { status: "DONE", commits: [], testSummary: "", interrupted: false },
  autoCommitted: false,
};
const withConcerns: ImplementOutcome = {
  reply: {
    status: "DONE_WITH_CONCERNS",
    commits: [],
    testSummary: "",
    concerns: "kept the AC-5 tests",
    interrupted: false,
  },
  autoCommitted: false,
};
const blocked: ImplementOutcome = {
  reply: { status: "BLOCKED", commits: [], testSummary: "", concerns: "which API?", interrupted: false },
  autoCommitted: false,
};
const interrupted: ImplementOutcome = {
  reply: {
    status: "DONE_WITH_CONCERNS",
    commits: [],
    testSummary: "",
    concerns: "step time limit reached",
    interrupted: true,
  },
  autoCommitted: false,
};
/** US-001's no-work signal: a reply with no status block at all. */
const noWork: ImplementOutcome = {
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
const noReply: ImplementOutcome = { autoCommitted: false };
const failed = (failure: string): ImplementOutcome => ({ failure, autoCommitted: false });

type ReportTurn = Extract<ImplementTurn, { kind: "report" }>;
type ContinueTurn = Extract<ImplementTurn, { kind: "continue" }>;
const reportTurns = (turns: readonly ImplementTurn[]): ReportTurn[] =>
  turns.filter((t): t is ReportTurn => t.kind === "report");
const continueTurns = (turns: readonly ImplementTurn[]): ContinueTurn[] =>
  turns.filter((t): t is ContinueTurn => t.kind === "continue");

interface DriveOptions {
  readonly script?: StoryLoopScript;
  /** `reportExists` answers, in order, the last repeating; absent reads as "the report is missing". */
  readonly report?: readonly boolean[] | "unwired" | "throws";
  readonly costExceeded?: () => boolean;
  readonly maxFixRounds?: number;
  readonly resume?: WorkflowStoryRecord | null;
  /** Further step overrides — `workProduced`, for the no-work ladder's fixtures. */
  readonly steps?: Partial<StoryLoopSteps>;
}

interface Driven extends StoryLoopHarness {
  /** Every step the loop drove, in order: `implement:<kind>`, `gates`, `storyReview`, `reReview`. */
  readonly order: string[];
  /** `ledger.length` as each report turn started, so a note can be proved to precede it. */
  readonly ledgerAtReport: number[];
  readonly reportCalls: { count: number };
}

function drive(opts: DriveOptions = {}): Driven {
  const answers = opts.report === "unwired" || opts.report === "throws" ? [] : (opts.report ?? [false]);
  const reportCalls = { count: 0 };
  const reportExists =
    opts.report === "unwired"
      ? undefined
      : async (): Promise<boolean> => {
          reportCalls.count += 1;
          if (opts.report === "throws") throw new Error("the report check could not read the story dir");
          return answers[Math.min(reportCalls.count - 1, answers.length - 1)] ?? false;
        };
  const harness = makeStoryLoopHarness(opts.script ?? {}, {
    ...(opts.maxFixRounds !== undefined ? { maxFixRounds: opts.maxFixRounds } : {}),
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    steps: {
      costExceeded: opts.costExceeded ?? (() => false),
      ...(reportExists === undefined ? {} : { reportExists }),
      ...opts.steps,
    },
  });
  const order: string[] = [];
  const ledgerAtReport: number[] = [];
  const steps = harness.env.steps;
  const implement = steps.implement;
  steps.implement = async (turn) => {
    order.push(`implement:${turn.kind}`);
    if (turn.kind === "report") ledgerAtReport.push(harness.ledger.length);
    return await implement(turn);
  };
  const gates = steps.gates;
  steps.gates = async () => {
    order.push("gates");
    return await gates();
  };
  const storyReview = steps.storyReview;
  steps.storyReview = async (concerns, gateStates) => {
    order.push("storyReview");
    return await storyReview(concerns, gateStates);
  };
  const reReview = steps.reReview;
  steps.reReview = async (round, findings, fixBase) => {
    order.push("reReview");
    return await reReview(round, findings, fixBase);
  };
  return { ...harness, order, ledgerAtReport, reportCalls };
}

describe("the report turn (US-008)", () => {
  test("AC-1: a DONE reply with no report gets a report turn after the gates and before the review", async () => {
    const h = drive();
    const out = await runStoryLoop(h.env);
    expect(h.order).toEqual(["implement:implement", "gates", "implement:report", "storyReview"]);
    expect(reportTurns(h.turns)).toHaveLength(1);
    expect(out.state).toBe("complete");
  });

  test("AC-2: a DONE_WITH_CONCERNS reply with no report gets a report turn", async () => {
    const h = drive({ script: { implement: () => withConcerns } });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(1);
  });

  test("AC-3: a report already on disk sends no report turn", async () => {
    const h = drive({ report: [true] });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(0);
    expect(h.order).toEqual(["implement:implement", "gates", "storyReview"]);
  });

  test("AC-4: a BLOCKED reply the advisor leaves unanswered sends no report turn", async () => {
    const h = drive({ script: { implement: () => blocked } });
    await runStoryLoop(h.env);
    expect(h.turns.filter((t) => t.kind === "answer")).toHaveLength(0);
    expect(reportTurns(h.turns)).toHaveLength(0);
  });

  test("AC-5: a red gate pass sends no report turn; the next pass does", async () => {
    const h = drive({ script: { gates: [RED_LINT, GREEN] } });
    await runStoryLoop(h.env);
    expect(h.order).toEqual([
      "implement:implement",
      "gates",
      "implement:fix",
      "gates",
      "implement:report",
      "storyReview",
    ]);
  });

  test("AC-6: the interrupt fallback sends no report turn", async () => {
    const h = drive({ script: { implement: () => interrupted } });
    await runStoryLoop(h.env);
    expect(continueTurns(h.turns)).toHaveLength(1);
    expect(reportTurns(h.turns)).toHaveLength(0);
  });

  test("AC-7: the cost limit reached after the gates sends no report turn", async () => {
    let calls = 0;
    const h = drive({
      costExceeded: () => {
        calls += 1;
        return calls > 1;
      },
    });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(0);
    expect(h.reportCalls.count).toBe(0);
  });

  test("AC-8: an unwired reportExists sends no report turn", async () => {
    const h = drive({ report: "unwired" });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(0);
    expect(h.order).toEqual(["implement:implement", "gates", "storyReview"]);
  });

  test("AC-9: a throwing reportExists sends no report turn", async () => {
    const h = drive({ report: "throws" });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(0);
  });

  test("AC-10: a throwing reportExists still lets the story review run", async () => {
    const h = drive({ report: "throws" });
    await runStoryLoop(h.env);
    expect(h.order).toContain("storyReview");
    expect(h.order).toEqual(["implement:implement", "gates", "storyReview"]);
  });

  test("AC-11: a resumed story sends no report turn on its first evaluate pass", async () => {
    const prior: WorkflowStoryRecord = { ...newStoryRecord("US-001", 5, "t"), phase: "review" };
    const h = drive({ resume: prior });
    await runStoryLoop(h.env);
    expect(h.turns).toHaveLength(0);
    expect(reportTurns(h.turns)).toHaveLength(0);
    expect(h.reportCalls.count).toBe(0);
  });

  test("AC-12: a report turn already spent is not sent again after a fix round", async () => {
    const h = drive({ script: { review: [failingReview()], reReviewAllAddressed: [true] } });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(1);
    expect(h.order).toEqual([
      "implement:implement",
      "gates",
      "implement:report",
      "storyReview",
      "implement:fix",
      "gates",
      "reReview",
    ]);
  });

  test("AC-13: a report that goes missing after a fix round gets a report turn before the re-review", async () => {
    const h = drive({
      script: { review: [failingReview()], reReviewAllAddressed: [true] },
      report: [true, false],
    });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(1);
    expect(h.order).toEqual([
      "implement:implement",
      "gates",
      "storyReview",
      "implement:fix",
      "gates",
      "implement:report",
      "reReview",
    ]);
  });
});

describe("what the report turn writes down (US-008)", () => {
  test("AC-14: the asking note is in the ledger before the report turn starts", async () => {
    const h = drive();
    await runStoryLoop(h.env);
    expect(h.ledgerAtReport).toHaveLength(1);
    expect(h.ledger.slice(0, h.ledgerAtReport[0])).toContain(MISSING_NOTE);
  });

  test("AC-15: a report written by the turn is noted as written", async () => {
    const h = drive({ report: [false, true] });
    await runStoryLoop(h.env);
    expect(h.ledger).toContain(WRITTEN_NOTE);
    expect(h.ledger).not.toContain(STILL_MISSING_NOTE);
  });

  test("AC-16: a report still missing after the turn is noted, and the review runs anyway", async () => {
    const h = drive({ report: [false, false] });
    await runStoryLoop(h.env);
    expect(h.ledger).toContain(STILL_MISSING_NOTE);
    expect(h.order.at(-1)).toBe("storyReview");
  });

  test("AC-17: a failed report turn is noted and adds no session finding", async () => {
    const h = drive({ script: { implement: (turn) => (turn.kind === "report" ? failed("boom") : DONE) } });
    await runStoryLoop(h.env);
    expect(h.ledger).toContain("report turn failed: boom");
    expect(h.ledger.some((line) => line.includes("implementer session failed"))).toBe(false);
    expect(h.record().openFindings).toEqual([]);
  });

  test("AC-18: an interrupted report turn gets no continue turn", async () => {
    const h = drive({ script: { implement: (turn) => (turn.kind === "report" ? interrupted : DONE) } });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(1);
    expect(continueTurns(h.turns)).toHaveLength(0);
    expect(h.order).toContain("storyReview");
  });

  test("AC-19: the report turn runs at the step-up of the turn that replied", async () => {
    const h = drive({
      script: { implement: (turn) => (turn.kind === "restart" && turn.fresh ? DONE : noWork) },
      steps: { workProduced: async () => false },
    });
    await runStoryLoop(h.env);
    expect(reportTurns(h.turns)).toHaveLength(1);
    expect(reportTurns(h.turns)[0]?.stepUps).toBe(1);
  });

  test("AC-22: a failed report turn still lets the story review run after it", async () => {
    const h = drive({ script: { implement: (turn) => (turn.kind === "report" ? failed("boom") : DONE) } });
    await runStoryLoop(h.env);
    expect(h.order).toEqual(["implement:implement", "gates", "implement:report", "storyReview"]);
  });
});

describe("a stale DONE never repairs a later report (US-008)", () => {
  test("AC-20: a failed fix round clears the DONE reply, so no report turn follows", async () => {
    const h = drive({
      script: { review: [failingReview()], implement: (turn) => (turn.kind === "fix" ? failed("boom") : DONE) },
      report: [true, false],
      maxFixRounds: 1,
    });
    await runStoryLoop(h.env);
    expect(h.reportCalls.count).toBe(1); // the first pass only: the report was present then
    expect(reportTurns(h.turns)).toHaveLength(0);
  });

  test("AC-21: a fix round with no reply clears the DONE reply, so no report turn follows", async () => {
    const h = drive({
      script: { review: [failingReview()], implement: (turn) => (turn.kind === "fix" ? noReply : DONE) },
      report: [true, false],
    });
    await runStoryLoop(h.env);
    expect(h.reportCalls.count).toBe(1);
    expect(reportTurns(h.turns)).toHaveLength(0);
  });
});
