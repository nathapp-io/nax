/**
 * US-002: the story loop stops spending fix rounds on a loop that cannot converge. A fix round that
 * changed nothing is not re-reviewed, and a residual the reviewer marked `narrower` is the same
 * problem in a smaller form — both go straight to the existing residual advisor.
 */
import { describe, expect, test } from "bun:test";
import { failingReview, makeStoryLoopAdvisor, makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import type { ResidualRequest } from "@/workflow/advisor";
import type { ImplementOutcome, ImplementTurn } from "@/workflow/implement";
import { runStoryLoop } from "@/workflow/story-loop";
import type { ReReviewVerdict } from "@/workflow/types";

const { OK } = storyLoopFixtures;
const MAX_FIX_ROUNDS = 3;

type Harness = ReturnType<typeof makeStoryLoopHarness>;

const fixes = (h: Harness) => h.turns.filter((turn) => turn.kind === "fix");

/** The residual advisor, recording every batch the loop sends it. */
function recordingAdvisor(requests: ResidualRequest[]) {
  return makeStoryLoopAdvisor({
    ruleResidual: async (request) => {
      requests.push(request);
      return { rulings: [], diagnoses: {} };
    },
  });
}

/** A fix turn that failed: its round keeps today's path, the re-review runs and the loop retries. */
const FAILED_FIX: ImplementOutcome = { failure: "session died", autoCommitted: false };
const failTheFirstFix = (turn: ImplementTurn): ImplementOutcome =>
  turn.kind === "fix" && turn.round === 1 ? FAILED_FIX : OK;

/** A re-review whose only asked finding came back PARTIAL, with or without the `narrower` flag. */
function partial(id: string, issue: string, narrower?: true): ReReviewVerdict {
  return {
    verdicts: [{ id, addressed: false, note: "", residual: { issue }, ...(narrower ? { narrower } : {}) }],
    newFindings: [],
  };
}

const notAddressed = (id: string): ReReviewVerdict["verdicts"][number] => ({ id, addressed: false, note: "" });

describe("runStoryLoop — a fix round that changed nothing (US-002)", () => {
  test("AC-7: the re-review is never called, and only the fix round's base is checked", async () => {
    const bases: string[] = [];
    const h = makeStoryLoopHarness(
      { review: [failingReview()] },
      {
        maxFixRounds: MAX_FIX_ROUNDS,
        steps: {
          fixDiffEmpty: async (fixBase) => {
            bases.push(fixBase);
            return true;
          },
        },
      },
    );
    await runStoryLoop(h.env);
    expect(h.reReviews).toHaveLength(0);
    expect(bases).toEqual(["h1"]);
  });

  test("AC-8: the open finding reaches the residual advisor exactly once", async () => {
    const requests: ResidualRequest[] = [];
    const h = makeStoryLoopHarness(
      { review: [failingReview()] },
      { maxFixRounds: MAX_FIX_ROUNDS, advisor: recordingAdvisor(requests), steps: { fixDiffEmpty: async () => true } },
    );
    await runStoryLoop(h.env);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.items.map((item) => item.id)).toContain("F1");
  });

  test("AC-9: the story ends after that one round instead of burning the remaining fix rounds", async () => {
    // The reviewer would keep the finding open every round, so today's path spends all three rounds
    // before the cap; the no-op round routes to the advisor instead.
    const h = makeStoryLoopHarness(
      { review: [failingReview()], reReviewAllAddressed: [false, false, false] },
      { maxFixRounds: MAX_FIX_ROUNDS, steps: { fixDiffEmpty: async () => true } },
    );
    const out = await runStoryLoop(h.env);
    expect(out.rounds).toBe(1);
  });

  test("AC-10: the ledger names every finding the no-op round sends to the advisor", async () => {
    const h = makeStoryLoopHarness(
      { review: [failingReview(2)] },
      { maxFixRounds: MAX_FIX_ROUNDS, steps: { fixDiffEmpty: async () => true } },
    );
    await runStoryLoop(h.env);
    expect(h.ledger).toContain("fix round r1 changed nothing: F1, F2 go to the advisor");
  });

  test("AC-11: a fix round that did change something is re-reviewed as today", async () => {
    const h = makeStoryLoopHarness(
      { review: [failingReview()] },
      { maxFixRounds: MAX_FIX_ROUNDS, steps: { fixDiffEmpty: async () => false } },
    );
    await runStoryLoop(h.env);
    expect(h.reReviews).toHaveLength(1);
    expect(h.reReviews[0]?.round).toBe(1);
  });

  test("AC-12: with no fixDiffEmpty step the loop keeps today's re-review path", async () => {
    const h = makeStoryLoopHarness({ review: [failingReview()] }, { maxFixRounds: MAX_FIX_ROUNDS });
    await runStoryLoop(h.env);
    expect(h.reReviews).toHaveLength(1);
    expect(h.reReviews[0]?.round).toBe(1);
  });

  test("AC-13: a fixDiffEmpty that rejects counts as not-empty, so the re-review still runs", async () => {
    const h = makeStoryLoopHarness(
      { review: [failingReview()] },
      {
        maxFixRounds: MAX_FIX_ROUNDS,
        steps: {
          fixDiffEmpty: async () => {
            throw new Error("git rev-parse failed");
          },
        },
      },
    );
    const out = await runStoryLoop(h.env);
    expect(h.reReviews).toHaveLength(1);
    expect(out.state).toBe("complete");
  });

  test("AC-14: a failed fix turn is re-reviewed rather than skipped as a no-op", async () => {
    const h = makeStoryLoopHarness(
      { review: [failingReview()], implement: failTheFirstFix, reReviewAllAddressed: [false, true] },
      { maxFixRounds: MAX_FIX_ROUNDS, steps: { fixDiffEmpty: async () => true } },
    );
    await runStoryLoop(h.env);
    expect(h.reReviews.map((call) => call.round)).toEqual([1]);
    expect(h.ledger).not.toContain("fix round r1 changed nothing: F1 go to the advisor");
  });

  test("AC-15: a failed fix turn keeps the retry path, so a second fix round runs", async () => {
    const h = makeStoryLoopHarness(
      { review: [failingReview()], implement: failTheFirstFix, reReviewAllAddressed: [false, true] },
      { maxFixRounds: MAX_FIX_ROUNDS, steps: { fixDiffEmpty: async () => true } },
    );
    const out = await runStoryLoop(h.env);
    expect(fixes(h).map((turn) => turn.round)).toEqual([1, 2]);
    expect(out.rounds).toBe(2);
  });
});

describe("runStoryLoop — a narrower residual (US-002)", () => {
  const NARROW = "still fails: a symlink inside the copied tree is followed";
  const narrowerRun = (requests: ResidualRequest[], verdict: ReReviewVerdict, review = failingReview()) =>
    makeStoryLoopHarness(
      { review: [review], reReviews: [verdict] },
      { maxFixRounds: MAX_FIX_ROUNDS, advisor: recordingAdvisor(requests) },
    );

  test("AC-16: a PARTIAL residual marked narrower spends no second fix round", async () => {
    const h = narrowerRun([], partial("F1", NARROW, true));
    const out = await runStoryLoop(h.env);
    expect(fixes(h)).toHaveLength(1);
    expect(out.rounds).toBe(1);
  });

  test("AC-17: the narrower residual's own text reaches the residual advisor", async () => {
    const requests: ResidualRequest[] = [];
    const h = narrowerRun(requests, partial("F1", NARROW, true));
    await runStoryLoop(h.env);
    expect(requests[0]?.items).toEqual([expect.objectContaining({ id: "F1", issue: NARROW })]);
  });

  test("AC-18: a PARTIAL residual without the flag still runs the next fix round", async () => {
    const h = narrowerRun([], partial("F1", NARROW));
    const out = await runStoryLoop(h.env);
    expect(fixes(h)).toHaveLength(2);
    expect(out.rounds).toBe(2);
  });

  test("AC-19: one narrower residual sends every still-open finding to the advisor", async () => {
    const requests: ResidualRequest[] = [];
    const verdict: ReReviewVerdict = {
      verdicts: [
        { id: "F1", addressed: false, note: "", residual: { issue: NARROW }, narrower: true },
        notAddressed("F2"),
      ],
      newFindings: [],
    };
    const h = narrowerRun(requests, verdict, failingReview(2));
    await runStoryLoop(h.env);
    expect(requests[0]?.items.map((item) => item.id)).toEqual(["F1", "F2"]);
  });
});
