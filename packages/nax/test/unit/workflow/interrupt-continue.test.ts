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
import type { WorkflowAdvisor } from "@/workflow/advisor";
import {
  autoCommitTurnEdits,
  type ImplementOutcome,
  type ImplementTurn,
  runImplementerTurn,
} from "@/workflow/implement";
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

/** US-007: the note the fallback writes when the spent tries leave a commit behind. */
const AUTO_COMMITTED = "auto-committed the implementer's uncommitted edits";
const AFTER_ONE = "stopped at the step limit after 1 continue attempt(s)";
/** The concern `recordConcern` builds from the fallback reply, as the story reviewer receives it. */
const COMMITTED_CONCERN = `DONE_WITH_CONCERNS: ${AFTER_ONE}; its uncommitted edits were auto-committed, and it may not have finished the story or written report.md`;
const NOTHING_CONCERN = `DONE_WITH_CONCERNS: ${AFTER_ONE}; nothing was auto-committed, and it may not have finished the story or written report.md`;

type AutoCommitDirty = NonNullable<StoryLoopSteps["autoCommitDirty"]>;

interface OrderedOpts {
  /** A fixed answer, the real seam, or absent for a caller that has not wired the step at all. */
  readonly autoCommit?: boolean | AutoCommitDirty;
  readonly steps?: Partial<StoryLoopSteps>;
  readonly interrupt?: Partial<InterruptLimits>;
  readonly advisor?: WorkflowAdvisor;
}

/**
 * The shared harness plus the two things the fallback ACs read: `events`, turns, gates and the
 * auto-commit interleaved in call order, and `seen`, the concerns each story review was handed.
 */
function orderedHarness(outcomes: ImplementOutcome[], over: OrderedOpts = {}) {
  const events: string[] = [];
  const seen: (readonly string[])[] = [];
  const next = scripted(...outcomes);
  const auto = over.autoCommit;
  const autoCommitDirty: Partial<StoryLoopSteps> =
    auto === undefined
      ? {}
      : {
          autoCommitDirty: () => {
            events.push("autoCommitDirty");
            return typeof auto === "function" ? auto() : Promise.resolve(auto);
          },
        };
  const h = makeStoryLoopHarness(
    {
      implement: (turn) => {
        events.push(`turn:${turn.kind}`);
        return next(turn);
      },
    },
    {
      advisor: over.advisor,
      steps: {
        gates: async () => {
          events.push("gates");
          return storyLoopFixtures.GREEN;
        },
        storyReview: async (concerns: readonly string[]) => {
          seen.push([...concerns]);
          const verdict: StoryReviewVerdict = storyLoopFixtures.PASS;
          return { ran: true, verdict };
        },
        ...autoCommitDirty,
        ...over.steps,
      },
    },
  );
  return { h, seen, events, env: envWith(h, over.interrupt) };
}

describe("interrupt fallback (US-007)", () => {
  test("AC-1: the fallback auto-commits once, after the continue turn and before the gates", async () => {
    const { env, events } = orderedHarness([interrupted], { autoCommit: true });
    await runStoryLoop(env);
    expect(events).toEqual(["turn:implement", "turn:continue", "autoCommitDirty", "gates"]);
  });

  test("AC-2: a committed fallback writes the auto-commit note exactly once", async () => {
    const { h, env } = orderedHarness([interrupted], { autoCommit: true });
    await runStoryLoop(env);
    expect(h.ledger.filter((line) => line === AUTO_COMMITTED)).toHaveLength(1);
  });

  test("AC-3: the review is told the uncommitted edits were auto-committed", async () => {
    const { seen, env } = orderedHarness([interrupted], { autoCommit: true });
    await runStoryLoop(env);
    expect(seen).toEqual([[COMMITTED_CONCERN]]);
  });

  test("AC-4: the ledger records the fallback as the interrupted implementer's concern", async () => {
    const { h, env } = orderedHarness([interrupted], { autoCommit: true });
    await runStoryLoop(env);
    expect(h.ledger).toContain(`implementer (interrupted) ${COMMITTED_CONCERN}`);
  });

  test("AC-5: an uncommitted fallback says nothing was auto-committed", async () => {
    const { seen, env } = orderedHarness([interrupted], { autoCommit: false });
    await runStoryLoop(env);
    expect(seen).toEqual([[NOTHING_CONCERN]]);
  });

  test("AC-6: an unwired auto-commit still records the nothing-was-committed concern, with no note", async () => {
    const { h, seen, env } = orderedHarness([interrupted]);
    await runStoryLoop(env);
    expect(seen).toEqual([[NOTHING_CONCERN]]);
    expect(h.ledger.filter((line) => line.includes(AUTO_COMMITTED))).toEqual([]);
  });

  test("AC-7: with no attempt allowed the fallback reports zero continue attempts", async () => {
    const { seen, env } = orderedHarness([interrupted], { interrupt: { maxAttempts: 0 } });
    await runStoryLoop(env);
    expect(seen[0]?.[0]).toContain("after 0 continue attempt(s)");
  });

  test("AC-8: an interrupted answer turn still ends in the fallback concern", async () => {
    const { h, seen, env } = orderedHarness([interrupted, needsContext, interrupted], {
      autoCommit: false,
      advisor: makeStoryLoopAdvisor({ answerQuestion: async () => "try X" }),
    });
    await runStoryLoop(env);
    expect(h.turns.map((turn) => turn.kind)).toEqual(["implement", "continue", "answer"]);
    expect(seen).toEqual([[NOTHING_CONCERN]]);
  });

  test("AC-9: a failed continue turn never reaches the fallback auto-commit", async () => {
    const { h, events, env } = orderedHarness([interrupted, failed], { autoCommit: true });
    await runStoryLoop(env);
    expect(events).not.toContain("autoCommitDirty");
    expect(h.record().openFindings.map((finding) => finding.issue)).toContain("implementer session failed: boom");
  });

  test("AC-10: the cost limit skips the continue, then falls back to the auto-commit", async () => {
    const { h, events, env } = orderedHarness([interrupted], {
      autoCommit: true,
      steps: { costExceeded: () => true },
    });
    await runStoryLoop(env);
    expect(h.turns).toEqual([{ kind: "implement" }]);
    expect(events).toContain("autoCommitDirty");
    const skipped = h.ledger.indexOf(COST_SKIP_60);
    const committed = h.ledger.indexOf(AUTO_COMMITTED);
    expect(skipped).toBeGreaterThan(-1);
    expect(committed).toBeGreaterThan(skipped);
  });
});

describe("interrupt fallback auto-commit failures (US-007)", () => {
  withDepsRestore(_workflowDeps, ["git", "autoCommitIfDirty"]);

  /** The real seam, wired as the loop's `autoCommitDirty` step: it resolves, never throws. */
  const realSeam = () => {
    const sc = makeStepContext();
    return () => autoCommitTurnEdits(sc);
  };

  test("AC-11: an empty dirty list emits no auto-commit note", async () => {
    let commits = 0;
    _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async () => {
      commits += 1;
    };
    const { h, seen, env } = orderedHarness([interrupted], { autoCommit: realSeam() });
    await runStoryLoop(env);
    expect(commits).toBe(0);
    expect(h.ledger.filter((line) => line.includes(AUTO_COMMITTED))).toEqual([]);
    expect(seen[0]?.[0]).toContain("nothing was auto-committed");
  });

  test("AC-12: a tree that cannot be read leaves the edits uncommitted", async () => {
    let commits = 0;
    _workflowDeps.git = async () => ({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 });
    _workflowDeps.autoCommitIfDirty = async () => {
      commits += 1;
    };
    const { h, seen, env } = orderedHarness([interrupted], { autoCommit: realSeam() });
    await runStoryLoop(env);
    expect(commits).toBe(0);
    expect(h.ledger.filter((line) => line.includes(AUTO_COMMITTED))).toEqual([]);
    expect(seen[0]?.[0]).toContain("nothing was auto-committed");
  });

  test("AC-13: a commit that throws leaves the edits uncommitted", async () => {
    let commits = 0;
    _workflowDeps.git = async () => ({ stdout: " M src/a.ts\n", exitCode: 0 });
    _workflowDeps.autoCommitIfDirty = async () => {
      commits += 1;
      throw new Error("commit failed");
    };
    const { h, seen, env } = orderedHarness([interrupted], { autoCommit: realSeam() });
    await runStoryLoop(env);
    expect(commits).toBe(1);
    expect(h.ledger.filter((line) => line.includes(AUTO_COMMITTED))).toEqual([]);
    expect(seen[0]?.[0]).toContain("nothing was auto-committed");
  });

  // F1: `autoCommitIfDirty` is fail-open — a dry run, a rejected workdir, a failed `git add` or an
  // empty staging set all return without committing. The fallback must not call that a commit.
  test("F1: an auto-commit that commits nothing says nothing was auto-committed", async () => {
    let commits = 0;
    // HEAD answers the same sha before and after the call: no commit was created.
    _workflowDeps.git = async (args) =>
      args[0] === "rev-parse" ? { stdout: "h1\n", exitCode: 0 } : { stdout: " M src/a.ts\n", exitCode: 0 };
    _workflowDeps.autoCommitIfDirty = async () => {
      commits += 1; // refused: nothing staged, so HEAD never moves
    };
    const { h, seen, env } = orderedHarness([interrupted], { autoCommit: realSeam() });
    await runStoryLoop(env);
    expect(commits).toBe(1);
    expect(h.ledger.filter((line) => line.includes(AUTO_COMMITTED))).toEqual([]);
    expect(seen).toEqual([[NOTHING_CONCERN]]);
  });

  test("F1: a commit that lands writes the note and the committed concern", async () => {
    let reads = 0;
    _workflowDeps.git = async (args) => {
      if (args[0] !== "rev-parse") return { stdout: " M src/a.ts\n", exitCode: 0 };
      reads += 1;
      return { stdout: reads === 1 ? "h1\n" : "h2\n", exitCode: 0 };
    };
    _workflowDeps.autoCommitIfDirty = async () => {};
    const { h, seen, env } = orderedHarness([interrupted], { autoCommit: realSeam() });
    await runStoryLoop(env);
    expect(h.ledger).toContain(AUTO_COMMITTED);
    expect(seen).toEqual([[COMMITTED_CONCERN]]);
  });
});
