import { describe, expect, test } from "bun:test";
import { makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import { runStoryLoop } from "@/workflow/story-loop";

const { RED_LINT } = storyLoopFixtures;
const scenarios = {
  red: () => makeStoryLoopHarness({ gates: [RED_LINT, RED_LINT] }, { maxFixRounds: 1 }),
  noWork: () =>
    makeStoryLoopHarness(
      {
        implement: () => ({
          reply: {
            status: "DONE_WITH_CONCERNS",
            commits: [],
            testSummary: "",
            concerns: "implementer reply carried no status block",
            interrupted: false,
            noStatusBlock: true,
          },
          autoCommitted: false,
        }),
      },
      { steps: { workProduced: async () => false } },
    ),
  clean: () => makeStoryLoopHarness(),
  cost: () => makeStoryLoopHarness({}, { steps: { costExceeded: () => true } }),
  skipped: () => makeStoryLoopHarness({ review: [null] }),
};

async function run(scenario: keyof typeof scenarios) {
  const h = scenarios[scenario]();
  const outcome = await runStoryLoop(h.env);
  const closed = h.updates.filter((patch) => patch.phase === "closed");
  expect(closed).toHaveLength(1);
  return { h, outcome, closing: closed[0], end: h.ledger.at(-1) };
}

// Each AC runs independently so one missing flag cannot hide another assertion's baseline result.
describe("runStoryLoop unreviewed closes", () => {
  test("AC-1: capped red lint returns unreviewed", async () => {
    expect((await run("red")).outcome.unreviewed).toBe(true);
  });
  test("AC-2: capped red lint never calls storyReview", async () => {
    const { h } = await run("red");
    expect(h.reviewGates).toEqual([]);
    expect(h.turns).toHaveLength(2);
  });
  test("AC-3: capped red lint end line says unreviewed", async () => {
    expect((await run("red")).end).toBe("complete-gate-open (1 round(s), red: lint, unreviewed)");
  });
  test("AC-4: capped red lint closing update persists unreviewed", async () => {
    const { closing, h } = await run("red");
    expect(closing?.unreviewed).toBe(true);
    expect(h.record().unreviewed).toBe(true);
  });
  test("AC-5: three no-work turns return unreviewed", async () => {
    const { outcome, h } = await run("noWork");
    expect(h.turns).toEqual([
      { kind: "implement" },
      { kind: "restart", fresh: false, stepUps: 0 },
      { kind: "restart", fresh: true, stepUps: 1 },
    ]);
    expect(outcome.unreviewed).toBe(true);
  });
  test("AC-6: no-work closing update persists unreviewed", async () => {
    expect((await run("noWork")).closing?.unreviewed).toBe(true);
  });
  test("AC-7: passing review returns reviewed", async () => {
    const { h, outcome } = await run("clean");
    expect(h.reviewGates).toHaveLength(1);
    expect(outcome.unreviewed).toBe(false);
  });
  test("AC-8: passing review closing update persists reviewed", async () => {
    expect((await run("clean")).closing?.unreviewed).toBe(false);
  });
  test("AC-9: cost stop before review returns unreviewed", async () => {
    const { h, outcome } = await run("cost");
    expect(h.reviewGates).toEqual([]);
    expect(outcome.unreviewed).toBe(true);
  });
  test("AC-10: cost stop retains its state and reason", async () => {
    expect((await run("cost")).outcome).toMatchObject({ state: "complete-gate-open", reason: "cost-limit" });
  });
  test("AC-11: unparseable review returns unreviewed", async () => {
    const { h, outcome } = await run("skipped");
    expect(h.reviewGates).toHaveLength(1);
    expect(h.record().reviewed).toBe(true);
    expect(outcome.unreviewed).toBe(true);
  });
  test("AC-12: unparseable review still completes", async () => {
    expect((await run("skipped")).outcome.state).toBe("complete");
  });
  test("AC-13: cost stop closing update persists unreviewed", async () => {
    expect((await run("cost")).closing?.unreviewed).toBe(true);
  });
  test("AC-14: cost stop end line says unreviewed", async () => {
    expect((await run("cost")).end).toEndWith(", unreviewed)");
  });
  test("AC-15: no-work end line says unreviewed", async () => {
    expect((await run("noWork")).end).toEndWith(", unreviewed)");
  });
});
