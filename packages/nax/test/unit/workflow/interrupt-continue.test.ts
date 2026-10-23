/**
 * US-006: an interrupted implementer turn is continued on the still-warm session, inside one
 * shared per-absorption retry allowance (spec §5).
 *
 * The continue logic is small, but every branch of it is a decision about the loop — whether a
 * turn is sent at all, what the ledger says, what the reviewer is told — so each AC drives
 * `runStoryLoop` through the shared story-loop harness and reads the turns it was handed.
 */
import { describe, expect, test } from "bun:test";
import {
  makeScriptedCallOp,
  makeStepContext,
  makeStoryLoopAdvisor,
  makeStoryLoopHarness,
  type StoryLoopHarness,
  storyLoopFixtures,
  withDepsRestore,
} from "@test/helpers";
import { type ImplementOutcome, type ImplementTurn, runImplementerTurn } from "@/workflow/implement";
import { newStoryRecord } from "@/workflow/result";
import { _workflowDeps } from "@/workflow/step-context";
import { runStoryLoop, type StoryLoopEnv, type StoryLoopSteps } from "@/workflow/story-loop";
import type { ImplementerReply, StoryReviewVerdict, WorkflowStoryRecord } from "@/workflow/types";

type InterruptLimits = NonNullable<StoryLoopEnv["interrupt"]>;
type ContinueTurn = Extract<ImplementTurn, { kind: "continue" }>;

/** US-005's defaults: one continue attempt, 60-minute implement and fix limits. */
const LIMITS: InterruptLimits = { maxAttempts: 1, implementMs: 3_600_000, fixMs: 3_600_000 };

const CONTINUING_60 =
  "implementer interrupted at the step limit (60 min): continuing on the warm session (attempt 1 of 1)";
const COST_SKIP_60 = "implementer interrupted at the step limit (60 min): continue skipped, cost limit reached";

/** The `env`, with the interrupt limits under test laid over US-005's defaults. */
function envWith(h: StoryLoopHarness, interrupt: Partial<InterruptLimits> = {}): StoryLoopEnv {
  return { ...h.env, interrupt: { ...LIMITS, ...interrupt } };
}

/** The parser's step-limit reply: DONE_WITH_CONCERNS carrying the interrupt marker. */
const interruptedReply: ImplementerReply = {
  status: "DONE_WITH_CONCERNS",
  commits: [],
  testSummary: "",
  concerns: "step time limit reached",
  interrupted: true,
};
const interrupted: ImplementOutcome = { reply: interruptedReply, autoCommitted: false };
const needsContext: ImplementOutcome = {
  reply: { status: "NEEDS_CONTEXT", commits: [], testSummary: "", concerns: "which API?", interrupted: false },
  autoCommitted: false,
};
const failed: ImplementOutcome = { failure: "boom", autoCommitted: false };

/** Successive implementer outcomes; the last one repeats, so `scripted(interrupted)` never recovers. */
function scripted(...outcomes: ImplementOutcome[]): (turn: ImplementTurn) => ImplementOutcome {
  let calls = 0;
  return () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)] ?? storyLoopFixtures.OK;
    calls += 1;
    return outcome;
  };
}

const continues = (turns: readonly ImplementTurn[]): ContinueTurn[] =>
  turns.filter((t): t is ContinueTurn => t.kind === "continue");

/** A `storyReview` that records the concerns it was handed, without disturbing the harness's turn log. */
function recordingReview(): { seen: (readonly string[])[]; steps: Partial<StoryLoopSteps> } {
  const seen: (readonly string[])[] = [];
  return {
    seen,
    steps: {
      storyReview: async (concerns: readonly string[]) => {
        seen.push([...concerns]);
        const verdict: StoryReviewVerdict = storyLoopFixtures.PASS;
        return { ran: true, verdict };
      },
    },
  };
}

describe("interrupt continue (US-006)", () => {
  test("AC-1: the interrupted first turn gets one continue turn of the implement limit", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted, storyLoopFixtures.OK) });
    await runStoryLoop(envWith(h));
    expect(continues(h.turns)).toEqual([
      { kind: "continue", limit: "implement", stepUps: 0, attempt: 1, maxAttempts: 1 },
    ]);
  });

  test("AC-2: the continue turn carries the files changed since the story base", async () => {
    const h = makeStoryLoopHarness(
      { implement: scripted(interrupted, storyLoopFixtures.OK) },
      { steps: { workSinceBase: async () => ["src/a.ts"] } },
    );
    await runStoryLoop(envWith(h));
    expect(continues(h.turns)[0]?.changedFiles).toEqual(["src/a.ts"]);
  });

  test("AC-3: an unreadable changed-file list still sends the continue turn, with no list", async () => {
    const h = makeStoryLoopHarness(
      { implement: scripted(interrupted, storyLoopFixtures.OK) },
      {
        steps: {
          workSinceBase: async () => {
            throw new Error("git diff failed");
          },
        },
      },
    );
    await runStoryLoop(envWith(h));
    const sent = continues(h.turns);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.changedFiles).toBeUndefined();
  });

  test("AC-15: with no workSinceBase step the continue turn is still sent, with no list", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted, storyLoopFixtures.OK) });
    await runStoryLoop(envWith(h));
    const sent = continues(h.turns);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.changedFiles).toBeUndefined();
  });

  test("AC-4: the ledger says the warm session is continuing", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted, storyLoopFixtures.OK) });
    await runStoryLoop(envWith(h));
    expect(h.ledger).toContain(CONTINUING_60);
  });

  test("AC-5: the recovered interrupt reaches the story review as no concern at all", async () => {
    const review = recordingReview();
    const h = makeStoryLoopHarness({ implement: scripted(interrupted, storyLoopFixtures.OK) }, { steps: review.steps });
    await runStoryLoop(envWith(h));
    expect(review.seen).toEqual([[]]);
  });

  test("AC-6: a recovered interrupt writes no (interrupted) ledger line", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted, storyLoopFixtures.OK) });
    await runStoryLoop(envWith(h));
    expect(h.ledger.filter((line) => line.includes("(interrupted)"))).toEqual([]);
  });

  test("AC-7: two attempts send two continue turns, numbered 1 then 2", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted) });
    await runStoryLoop(envWith(h, { maxAttempts: 2 }));
    expect(continues(h.turns).map((turn) => turn.attempt)).toEqual([1, 2]);
    expect(continues(h.turns).map((turn) => turn.maxAttempts)).toEqual([2, 2]);
  });

  test("AC-8: with no attempt allowed the interrupted turn sends no continue turn", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted, storyLoopFixtures.OK) });
    await runStoryLoop(envWith(h, { maxAttempts: 0 }));
    expect(continues(h.turns)).toEqual([]);
    expect(h.turns).toEqual([{ kind: "implement" }]);
  });

  test("AC-9: a reached cost limit skips the continue turn and says so", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted) }, { steps: { costExceeded: () => true } });
    await runStoryLoop(envWith(h));
    expect(continues(h.turns)).toEqual([]);
    expect(h.ledger).toContain(COST_SKIP_60);
  });

  test("AC-10: an interrupted fix round continues at the fix limit, with its own step-up", async () => {
    // Round 3 of 4 is the last warm round, so round 4 runs at stepUps 1 (WARM_ROUND_CAP is 3).
    const resume: WorkflowStoryRecord = {
      ...newStoryRecord("US-001", 4, "t"),
      round: 3,
      reviewed: true,
      openFindings: [{ id: "F2", kind: "spec", severity: "important", issue: "gap" }],
      nextFindingId: 3,
    };
    const h = makeStoryLoopHarness(
      { gates: [storyLoopFixtures.RED_LINT], implement: scripted(interrupted, storyLoopFixtures.OK) },
      { resume, maxFixRounds: 4, steps: { costExceeded: () => false } },
    );
    await runStoryLoop(envWith(h));
    expect(h.turns.some((turn) => turn.kind === "fix" && turn.stepUps === 1)).toBe(true);
    expect(continues(h.turns)).toEqual([{ kind: "continue", limit: "fix", stepUps: 1, attempt: 1, maxAttempts: 1 }]);
  });

  test("AC-11: a 90-minute implement limit reads as 90 minutes in the note", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted, storyLoopFixtures.OK) });
    await runStoryLoop(envWith(h, { implementMs: 5_400_000 }));
    expect(h.ledger).toContain(
      "implementer interrupted at the step limit (90 min): continuing on the warm session (attempt 1 of 1)",
    );
  });

  test("AC-12: an answer turn follows the continue turn that asked", async () => {
    const h = makeStoryLoopHarness(
      { implement: scripted(interrupted, needsContext, storyLoopFixtures.OK) },
      { advisor: makeStoryLoopAdvisor({ answerQuestion: async () => "try X" }) },
    );
    await runStoryLoop(envWith(h));
    expect(h.turns.map((turn) => turn.kind)).toEqual(["implement", "continue", "answer"]);
  });

  test("AC-13: an interrupted answer spends no second continue once the attempt is used", async () => {
    const h = makeStoryLoopHarness(
      { implement: scripted(interrupted, needsContext, interrupted) },
      { advisor: makeStoryLoopAdvisor({ answerQuestion: async () => "try X" }) },
    );
    await runStoryLoop(envWith(h));
    expect(h.turns.map((turn) => turn.kind)).toEqual(["implement", "continue", "answer"]);
    expect(continues(h.turns)).toHaveLength(1);
  });

  test("AC-14: a failed continue turn is an implementer session finding", async () => {
    const h = makeStoryLoopHarness({ implement: scripted(interrupted, failed) });
    await runStoryLoop(envWith(h));
    expect(h.record().openFindings.map((finding) => finding.issue)).toContain("implementer session failed: boom");
  });
});

describe("interrupt continue failure handling (US-006)", () => {
  withDepsRestore(_workflowDeps, ["callOp"]);

  test("AC-16: a continue whose operation throws is absorbed as an implementer session failure", async () => {
    // The real turn runner: an operation throw becomes `failure`, never a fallback. The first turn is
    // interrupted; every call after it throws, so the continue turn is the one that fails.
    let calls = 0;
    _workflowDeps.callOp = makeScriptedCallOp(() => {
      calls += 1;
      if (calls === 1) return interruptedReply;
      throw new Error("boom");
    });
    const sc = makeStepContext();
    const h = makeStoryLoopHarness({ implement: (turn) => runImplementerTurn(sc, turn) });
    await runStoryLoop(envWith(h));
    expect(continues(h.turns)).toHaveLength(1);
    expect(h.record().openFindings.map((finding) => finding.issue)).toContain("implementer session failed: boom");
  });
});
