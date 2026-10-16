/** US-001: what `publish` leaves on the feature record, so the verdict can list what is still open. */
import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeDoneStory, makeFeatureMachineHarness } from "@test/helpers";
import { runFeatureMachine } from "@/workflow/feature-machine";

const { PUBLISHED } = featureMachineFixtures;
const harness = makeFeatureMachineHarness;

describe("the record keeps the approval outcome (US-001)", () => {
  const HELD = { approved: false, rationale: "advisor held: r", decisionId: "D-1" } as const;

  test("AC-14: the approval the publish step returned is on the final record", async () => {
    const final = await runFeatureMachine(harness({ published: { ...PUBLISHED, approval: HELD } }).env);
    expect(final.approval).toEqual({ approved: false, rationale: "advisor held: r", decisionId: "D-1" });
  });

  test("AC-17: an outcome with no approval leaves the key off the record", async () => {
    const final = await runFeatureMachine(harness({}).env);
    // The premise: the default outcome published, and carries no approval of its own.
    expect(final.outcome).toBe("ready");
    expect("approval" in PUBLISHED).toBe(false);
    expect("approval" in final).toBe(false);
  });
});

describe("the record keeps the CI detail (US-001)", () => {
  test("AC-15: the detail the publish step returned is on the final record", async () => {
    const final = await runFeatureMachine(
      harness({ published: { ...PUBLISHED, ciDetail: "PR #9 has merge conflicts" } }).env,
    );
    expect(final.ciDetail).toBe("PR #9 has merge conflicts");
  });

  test("an outcome with no detail leaves the key off the record", async () => {
    const final = await runFeatureMachine(harness({}).env);
    expect("ciDetail" in final).toBe(false);
  });
});

describe("the record keeps each story's end state (US-001)", () => {
  test("AC-16: storyStates mirrors facts.stories, in order, with the reason where there is one", async () => {
    const h = harness(
      {},
      {
        stories: [
          makeDoneStory("US-001"),
          makeDoneStory("US-002", { state: "complete-gate-open", reason: "red: lint" }),
        ],
      },
    );
    const final = await runFeatureMachine(h.env);
    expect(final.storyStates).toEqual([
      { id: "US-001", state: "complete" },
      { id: "US-002", state: "complete-gate-open", reason: "red: lint" },
    ]);
  });

  test("a story with no reason carries no reason key", async () => {
    const final = await runFeatureMachine(harness({}, { stories: [makeDoneStory("US-001")] }).env);
    expect(final.storyStates).toEqual([{ id: "US-001", state: "complete" }]);
  });

  test("every story is recorded, unfinished ones included", async () => {
    const h = harness({}, { stories: [makeDoneStory("US-001"), makeDoneStory("US-002", { state: "not-run" })] });
    const final = await runFeatureMachine(h.env);
    expect(final.storyStates?.map((s) => s.state)).toEqual(["complete", "not-run"]);
  });
});
