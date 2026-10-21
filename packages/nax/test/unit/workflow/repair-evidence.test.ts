/**
 * The repair lines the approval advisor reads (US-008). A repair commits after the re-review, so
 * its diff reaches the PR unreviewed and the advisor has to be told.
 */
import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { repairEvidence } from "@/workflow/repair-evidence";
import type { WorkflowFeatureRecord } from "@/workflow/types";

const GATE_LINE = "Gate repair: 1 round(s) after the final gates went red; the repair diff was not re-reviewed";
const CI_LINE = "CI repair: 2 round(s) after CI failed on the PR; the repair diff was not re-reviewed";

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

  test("the gate-repair line comes before the CI-repair line", () => {
    const lines = repairEvidence(record({ gateRepairRounds: 1, ciRepairRounds: 2 }));
    expect(lines).toEqual([GATE_LINE, CI_LINE]);
  });

  test("a round count of zero says nothing", () => {
    expect(repairEvidence(record({ gateRepairRounds: 0, ciRepairRounds: 0 }))).toEqual([]);
  });
});
