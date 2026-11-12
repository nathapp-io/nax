/**
 * The repair lines the approval advisor reads (US-008). A repair commits after the re-review, so
 * its diff reaches the PR unreviewed and the advisor has to be told — or, since US-006, told that
 * the repair's own diff was reviewed and what that review found.
 */
import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { repairEvidence } from "@/workflow/repair-evidence";
import type { WorkflowFeatureRecord } from "@/workflow/types";

const GATE_LINE = "Gate repair: 1 round(s) after the final gates went red; the repair diff was not re-reviewed";
const CI_LINE = "CI repair: 2 round(s) after CI failed on the PR; the repair diff was not re-reviewed";
const GATE_REVIEWED = "Gate repair: 1 round(s) after the final gates went red; the repair diff was reviewed";
const CI_REVIEWED = "CI repair: 1 round(s) after CI failed on the PR; the repair diff was reviewed";

function record(over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
  return { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), ...over };
}

describe("repairEvidence", () => {
  test("AC-8: a gate repair is named as an unreviewed diff", () => {
    expect(repairEvidence(record({ gateRepairRounds: 1 }))).toEqual([GATE_LINE]);
  });

  test("AC-9: a CI repair is named as an unreviewed diff", () => {
    expect(repairEvidence(record({ ciRepairRounds: 2 }))).toEqual([CI_LINE]);
  });

  test("AC-10: no repair round, no repair line", () => {
    expect(repairEvidence(record())).toEqual([]);
  });

  test("AC-5: an older record with no repairReviews keeps both lines unreviewed, gate before CI", () => {
    const lines = repairEvidence(record({ gateRepairRounds: 1, ciRepairRounds: 2 }));
    expect(lines).toEqual([GATE_LINE, CI_LINE]);
  });

  test("a round count of zero says nothing", () => {
    expect(repairEvidence(record({ gateRepairRounds: 0, ciRepairRounds: 0 }))).toEqual([]);
  });
});

// US-006: a repair whose diff WAS reviewed no longer reads as an unreviewed one, and the review
// lines the repair rounds recorded follow the round summaries.
describe("repairEvidence with repairReviews (US-006)", () => {
  test("AC-1: a reviewed gate repair says so, then the round's own line", () => {
    const lines = repairEvidence(
      record({ gateRepairRounds: 1, repairReviews: ["gate repair r1 reviewed: G1 addressed"] }),
    );
    expect(lines).toEqual([GATE_REVIEWED, "gate repair r1 reviewed: G1 addressed"]);
  });

  test("AC-2: a skipped gate repair review keeps the unreviewed line, then says why", () => {
    const lines = repairEvidence(
      record({ gateRepairRounds: 1, repairReviews: ["gate repair r1 review skipped: timeout"] }),
    );
    expect(lines).toEqual([GATE_LINE, "gate repair r1 review skipped: timeout"]);
  });

  test("AC-3: a reviewed CI repair says so, then the round's own line", () => {
    const lines = repairEvidence(record({ ciRepairRounds: 1, repairReviews: ["CI repair r1 reviewed: C1 addressed"] }));
    expect(lines).toEqual([CI_REVIEWED, "CI repair r1 reviewed: C1 addressed"]);
  });

  test("a gate review never marks the CI repair reviewed, and every entry follows both summaries", () => {
    const reviews = ["gate repair r1 reviewed: G1 addressed", "CI repair r2 review skipped: timeout"];
    const lines = repairEvidence(record({ gateRepairRounds: 1, ciRepairRounds: 2, repairReviews: reviews }));
    expect(lines).toEqual([GATE_REVIEWED, CI_LINE, ...reviews]);
  });

  test("a review line whose round the record does not count is kept, and marks nothing reviewed", () => {
    expect(repairEvidence(record({ repairReviews: ["gate repair r1 reviewed: G1 addressed"] }))).toEqual([
      "gate repair r1 reviewed: G1 addressed",
    ]);
  });
});
