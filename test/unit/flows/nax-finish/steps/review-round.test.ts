import { afterEach, describe, expect, test } from "bun:test";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import { routeReviewAndRecord } from "@flows/nax-finish/steps/review-round";
import type { FinishRound } from "@flows/nax-finish/types";
import { makeFlowStep } from "@test/helpers";

const originalAppendText = _resultDeps.appendText;
afterEach(() => {
  _resultDeps.appendText = originalAppendText;
});

const INPUT = {
  auditDir: "/home/u/.nax/proj/finish-audit/feat-x",
  workdir: "/repo",
  feature: "feat-x",
  runId: "run-1",
};

const FINDING = { severity: "HIGH", title: "t", problem: "p", fix: "f" };

/** Capture every round `routeReviewAndRecord` appends, parsed back from JSONL. */
function captureRounds(): FinishRound[] {
  const written: FinishRound[] = [];
  _resultDeps.appendText = async (_p, s) => {
    for (const line of s.split("\n")) if (line.trim()) written.push(JSON.parse(line));
  };
  return written;
}

const ctxWith = (verdict: unknown, steps = [makeFlowStep("review_quality")]) => ({
  input: INPUT,
  outputs: { review_quality: verdict },
  state: { steps },
});

describe("routeReviewAndRecord", () => {
  test("records a round when the review passes with no findings", async () => {
    const rounds = captureRounds();
    const r = await routeReviewAndRecord(ctxWith({ route: "clean", findings: [] }), "quality");

    expect(r.route).toBe("clean");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      phase: "quality",
      committed: false,
      findings: [],
      outcome: "passed",
    });
    expect(rounds[0].sha).toBeUndefined();
  });

  test("does NOT record when the review routes to fix — commit_<phase> records that round", async () => {
    // The round is appended at `commit_<phase>`, where the findings AND the
    // resulting commit are both known. Recording here too would double-count it.
    const rounds = captureRounds();
    const r = await routeReviewAndRecord(ctxWith({ route: "proceed", findings: [FINDING] }), "quality");

    expect(r.route).toBe("fix");
    expect(rounds).toEqual([]);
  });

  test("records an unparseable review as its own outcome, not as a pass", async () => {
    const rounds = captureRounds();
    await routeReviewAndRecord(ctxWith({ route: "reprompt", findings: [], raw: "prose" }), "quality");

    expect(rounds[0]).toMatchObject({ outcome: "unparseable", committed: false });
  });

  test("records an escalated review as its own outcome", async () => {
    const rounds = captureRounds();
    await routeReviewAndRecord(ctxWith({ route: "escalate", findings: [], escalationReason: "judgment" }), "quality");

    expect(rounds[0]).toMatchObject({ outcome: "escalated" });
  });

  test("records the absent-verdict escalation, so a reviewer that emitted nothing leaves a trace", async () => {
    const rounds = captureRounds();
    const r = await routeReviewAndRecord({ input: INPUT, outputs: {}, state: { steps: [] } }, "quality");

    expect(r.route).toBe("escalate");
    expect(rounds[0]).toMatchObject({ outcome: "escalated" });
  });

  test("numbers the attempt by review round, not by fix count", async () => {
    const rounds = captureRounds();
    const steps = [
      makeFlowStep("review_quality"),
      makeFlowStep("fix_quality"),
      makeFlowStep("commit_quality"),
      makeFlowStep("review_quality"),
    ];
    await routeReviewAndRecord(ctxWith({ route: "clean", findings: [] }, steps), "quality");

    expect(rounds[0].attempt).toBe(2);
  });

  test("carries the findings a clean-after-escalate verdict reported", async () => {
    const rounds = captureRounds();
    await routeReviewAndRecord(ctxWith({ route: "escalate", findings: [FINDING] }), "quality");

    expect(rounds[0].findings).toHaveLength(1);
  });

  test("an unwritable audit dir does not fail the route", async () => {
    _resultDeps.appendText = async () => {
      throw new Error("EACCES");
    };
    const r = await routeReviewAndRecord(ctxWith({ route: "clean", findings: [] }), "quality");
    expect(r.route).toBe("clean");
  });
});
