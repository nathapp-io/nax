import { describe, expect, test } from "bun:test";
import { featureMachineFixtures, makeDoneStory, makeFeatureMachineHarness } from "@test/helpers";
import type { FeatureEnv } from "@/workflow/feature-machine";
import { newFeatureRecord } from "@/workflow/feature-record";
import { branchReviewStep, NO_MIRROR, publishStep } from "@/workflow/feature-steps";
import type { PublishOutcome } from "@/workflow/finalize";
import type { LedgerWriteOptions } from "@/workflow/ledger";
import type { WorkflowFeatureRecord } from "@/workflow/types";

/** A record the branch-review step runs on: a seed to review, no minors to triage. */
const reviewed = () => ({
  ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
  step: "branch-review" as const,
});

describe("branchReviewStep", () => {
  // US-009: the branch review lists each story's report, so the story's own run dir survives the step boundary.
  test("passes a story's run dir through to the branch review facts (AC-9)", async () => {
    const h = makeFeatureMachineHarness({}, { stories: [makeDoneStory("US-001", { runDir: "/run" })] });
    await branchReviewStep(h.env, reviewed());
    expect(h.reviewFacts[0]?.stories).toEqual([{ id: "US-001", state: "complete", runDir: "/run" }]);
  });

  test("a story with no run dir carries no runDir key", async () => {
    const h = makeFeatureMachineHarness({}, { stories: [makeDoneStory("US-001")] });
    await branchReviewStep(h.env, reviewed());
    expect(h.reviewFacts[0]?.stories).toEqual([{ id: "US-001", state: "complete" }]);
  });
});

/** A publish grade the CI wait reports no re-run for, and the record it starts from. */
const published = (over: Partial<PublishOutcome> = {}): PublishOutcome => ({
  ...featureMachineFixtures.PUBLISHED,
  ...over,
});
const started = (over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "seed0", minors: [] }),
  ...over,
});

/** The step's env with its ledger writes recorded, text and options both. */
function ledgerHarness(out: PublishOutcome, record: WorkflowFeatureRecord) {
  const h = makeFeatureMachineHarness({ published: out }, { record });
  const writes: { text: string; options?: LedgerWriteOptions }[] = [];
  const env: FeatureEnv = {
    ...h.env,
    sink: {
      ...h.env.sink,
      ledger: async (text, options) => {
        writes.push({ text, options });
      },
    },
  };
  return { env, writes };
}

describe("publishStep CI re-runs (US-003)", () => {
  // US-003: a wait that re-ran a check is a fact the ledger must carry — it is the only record of
  // the re-run, since nax posts no PR comment about it.
  test("AC-15: the re-ran names become a ledger note with NO_MIRROR and the record's ciReruns", async () => {
    const rec = started();
    const { env, writes } = ledgerHarness(published({ ciReruns: ["test"] }), rec);
    const result = await publishStep(env, rec);
    expect(writes).toContainEqual({
      text: "CI re-ran test: they passed on another pipeline for the same commit",
      options: NO_MIRROR,
    });
    expect(result.patch?.ciReruns).toEqual(["test"]);
  });

  // US-003: the key is *this* publish's fact, so a publish that re-ran nothing clears what an
  // earlier publish recorded instead of leaving it behind.
  test("AC-16: a publish that re-ran nothing writes no note and clears the key", async () => {
    const rec = started({ ciReruns: ["x"] });
    const { env, writes } = ledgerHarness(published(), rec);
    const result = await publishStep(env, rec);
    expect(writes.some((write) => write.text.startsWith("CI re-ran"))).toBe(false);
    expect(result.patch).toHaveProperty("ciReruns");
    expect(result.patch?.ciReruns).toBeUndefined();
  });
});
