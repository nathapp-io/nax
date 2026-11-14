import { describe, expect, test } from "bun:test";
import { makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import { runStoryLoop } from "@/workflow/story-loop";
import type { GateRunResult } from "@/workflow/types";

const green: GateRunResult = { red: false, states: { scoped: "green" }, findings: [] };

describe("runStoryLoop suite reuse", () => {
  test.each([true, false])("suite coverage %s controls the suite call", async (covered) => {
    let calls = 0;
    const gates: GateRunResult = covered ? { ...green, suiteCovered: true } : green;
    const h = makeStoryLoopHarness(
      { gates: [gates] },
      {
        steps: {
          fullSuite: async () => {
            calls++;
            return storyLoopFixtures.SUITE_GREEN;
          },
        },
      },
    );
    const outcome = await runStoryLoop(h.env);
    expect(calls).toBe(covered ? 0 : 1);
    expect(outcome.state).toBe("complete");
    expect(h.reviewGates[0]?.["full-suite"]).toBe("green");
    if (covered) expect(h.ledger).toContain("full-suite green (scoped gate ran the full-suite command; reused)");
  });
});
