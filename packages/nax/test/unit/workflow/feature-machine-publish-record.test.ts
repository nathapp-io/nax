/** US-001: what `publish` leaves on the feature record, so the verdict can list what is still open. */
import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeDoneStory, makeFeatureMachineHarness } from "@test/helpers";
import { runFeatureMachine } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import type { PublishOutcome } from "@/workflow/finalize";
import { buildOpenItems } from "@/workflow/open-items";
import type { WorkflowFeatureRecord } from "@/workflow/types";

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

describe("a resumed transient draft re-publishes onto a clean slate (US-001, B1)", () => {
  const HELD = { approved: false, rationale: "advisor held: earlier", decisionId: "D-1" } as const;
  /** A publish whose CI failed: a deterministic reason, so no advisor was asked and there is no detail. */
  const FAILED: PublishOutcome = { outcome: "draft", ci: "failed", reasons: ["CI failed"] };

  /** What an interrupted publish leaves behind: its own hold, its own CI detail, the PR it opened. */
  const resumedDraft = (): WorkflowFeatureRecord => ({
    ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
    step: "publish",
    outcome: "draft",
    ci: "unavailable",
    ciDetail: "gh: 502",
    approval: HELD,
    url: "https://gh/pr/1",
    reasons: ["PR update failed: timeout"],
  });

  test("B1: a publish that asked no advisor drops the earlier hold", async () => {
    const final = await runFeatureMachine(harness({ published: FAILED }, { record: resumedDraft() }).env);
    // The premise: this publish did produce a record, with a deterministic draft reason.
    expect(final.outcome).toBe("draft");
    expect(final.reasons).toEqual(["CI failed"]);
    expect("approval" in final).toBe(false);
    // What the finding observed: the verdict listed the hold of a publish that asked no advisor.
    expect(buildOpenItems(final).filter((i) => i.kind === "advisor")).toEqual([]);
  });

  test("B1: the earlier CI detail goes with the approval", async () => {
    const final = await runFeatureMachine(harness({ published: FAILED }, { record: resumedDraft() }).env);
    expect("ciDetail" in final).toBe(false);
  });

  test("a publish that does ask the advisor replaces the earlier hold rather than keeping both", async () => {
    const LATER = { approved: false, rationale: "advisor held: later", decisionId: "D-2" } as const;
    const final = await runFeatureMachine(
      harness({ published: { ...FAILED, approval: LATER } }, { record: resumedDraft() }).env,
    );
    expect(final.approval).toEqual({ approved: false, rationale: "advisor held: later", decisionId: "D-2" });
  });

  test("the transient draft keeps the PR url the re-publish did not return again", async () => {
    const final = await runFeatureMachine(harness({ published: FAILED }, { record: resumedDraft() }).env);
    expect(final.url).toBe("https://gh/pr/1");
  });
});
