import { describe, expect, test } from "bun:test";
import { failingReview, makeStoryLoopHarness, recordStoryTrace, storyLoopFixtures } from "@test/helpers";
import { runStoryLoop } from "@/workflow/story-loop";
import type { GateRunResult } from "@/workflow/types";

const { SUITE_RED, SUITE_GREEN, RED_LINT, GREEN } = storyLoopFixtures;

const fixes = (h: ReturnType<typeof makeStoryLoopHarness>) => h.turns.filter((turn) => turn.kind === "fix");

// Record at the real loop seams while retaining the harness's queued results and captures.
async function traced(h: ReturnType<typeof makeStoryLoopHarness>) {
  const trace = await recordStoryTrace("suite-first", h);
  return {
    calls: trace.events.flatMap((event) => (event.kind === "call" ? [event.method] : [])),
    outcome: trace.end.returned,
  };
}

describe("runStoryLoop suite-first passes", () => {
  test("AC-1/AC-2/AC-3: green pass runs gates, suite, review with merged states and ordered phases", async () => {
    const h = makeStoryLoopHarness();
    const { calls } = await traced(h);
    expect(calls.filter((name) => ["gates", "fullSuite", "storyReview"].includes(name))).toEqual([
      "gates",
      "fullSuite",
      "storyReview",
    ]);
    expect(h.updates.flatMap((patch) => (patch.phase ? [patch.phase] : []))).toEqual([
      "implement",
      "gates",
      "suite",
      "review",
      "closed",
    ]);
    expect(h.reviewGates).toEqual([{ lint: "green", typecheck: "green", scoped: "green", "full-suite": "green" }]);
  });

  test("AC-4/AC-5/AC-6/AC-7/AC-8: red then green suite fixes before the only review", async () => {
    const h = makeStoryLoopHarness({ suite: [SUITE_RED, SUITE_GREEN] }, { maxFixRounds: 2 });
    const { calls, outcome } = await traced(h);
    const fixIndex = calls.indexOf("implement", calls.indexOf("implement") + 1);
    expect(calls.slice(0, fixIndex)).not.toContain("storyReview");
    expect(fixes(h)[0]?.findings).toEqual([expect.objectContaining({ kind: "gate", gate: "full-suite" })]);
    expect(h.reviewGates).toHaveLength(1);
    expect(calls.indexOf("storyReview")).toBeGreaterThan(calls.lastIndexOf("fullSuite"));
    expect(calls.filter((name) => name === "fullSuite")).toHaveLength(2);
    expect(outcome).toMatchObject({ state: "complete", rounds: 1 });
  });

  test("AC-9: a red suite defers the missing-report check and report turn until after the fix", async () => {
    let checks = 0;
    const checksAtFix: number[] = [];
    const h = makeStoryLoopHarness(
      {
        suite: [SUITE_RED, SUITE_GREEN],
        implement: (turn) => {
          if (turn.kind === "fix") checksAtFix.push(checks);
          return storyLoopFixtures.OK;
        },
      },
      {
        maxFixRounds: 2,
        steps: {
          reportExists: async () => {
            checks++;
            return false;
          },
        },
      },
    );
    await runStoryLoop(h.env);
    expect(checksAtFix).toEqual([0]);
    expect(h.turns.map((turn) => turn.kind)).toEqual(["implement", "fix", "report"]);
  });

  test("AC-10/AC-11/AC-12/AC-13/AC-14: red suite preserves open F1 and its original fix base", async () => {
    const h = makeStoryLoopHarness(
      { review: [failingReview()], suite: [SUITE_GREEN, SUITE_RED, SUITE_GREEN] },
      { maxFixRounds: 3 },
    );
    const { calls } = await traced(h);
    expect(fixes(h)[1]?.findings).toEqual([
      expect.objectContaining({ id: "F2", kind: "gate", gate: "full-suite" }),
      expect.objectContaining({ id: "F1", kind: "spec" }),
    ]);
    const firstFix = calls.indexOf("implement", 1);
    const secondFix = calls.indexOf("implement", firstFix + 1);
    expect(secondFix).toBeGreaterThan(firstFix);
    expect(calls.slice(firstFix, secondFix)).not.toContain("reReview");
    expect(h.reReviews).toEqual([expect.objectContaining({ round: 2, fixBase: "h1" })]);
    expect(calls.filter((name) => name === "head")).toHaveLength(1);
  });

  test("AC-15/AC-16: skipped suite still reaches review with its skipped state", async () => {
    const skipped: GateRunResult = { red: false, states: { "full-suite": "skipped" }, findings: [] };
    const h = makeStoryLoopHarness({ suite: [skipped] });
    await runStoryLoop(h.env);
    expect(h.reviewGates).toEqual([{ ...GREEN.states, "full-suite": "skipped" }]);
  });

  test("AC-17/AC-18: suite error escapes unchanged without spending the review", async () => {
    const error = new Error("suite failed to start");
    const h = makeStoryLoopHarness(
      {},
      {
        steps: {
          fullSuite: async () => {
            throw error;
          },
        },
      },
    );
    await expect(runStoryLoop(h.env)).rejects.toBe(error);
    expect(h.reviewGates).toHaveLength(0);
  });

  test("AC-19/AC-20/AC-21: red lint gates reach the fix without suite or review", async () => {
    const h = makeStoryLoopHarness({ gates: [RED_LINT, GREEN] });
    const { calls } = await traced(h);
    const firstFix = calls.indexOf("implement", 1);
    expect(firstFix).toBeGreaterThan(0);
    expect(calls.slice(0, firstFix)).not.toContain("fullSuite");
    expect(calls.slice(0, firstFix)).not.toContain("storyReview");
    expect(fixes(h)[0]?.findings).toEqual([expect.objectContaining({ kind: "gate", gate: "lint" })]);
  });

  test("red suite at the cap goes to residual without a review or another fix", async () => {
    const h = makeStoryLoopHarness({ suite: [SUITE_RED, SUITE_RED] }, { maxFixRounds: 1 });
    const { calls } = await traced(h);
    expect(h.reviewGates).toHaveLength(0);
    expect(fixes(h)).toHaveLength(1);
    expect(calls.filter((name) => name === "fullSuite")).toHaveLength(2);
    expect(h.record().state).toBe("complete-gate-open");
  });
});
