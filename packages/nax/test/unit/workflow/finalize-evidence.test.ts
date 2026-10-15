/** What the approval advisor is told about a feature before it rules on readiness. */
import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { approvalEvidence } from "@/workflow/finalize";

const record = {
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  reviewRan: true,
  finalGates: { ran: ["test"], failing: [] },
};
const ci = { outcome: "green", detail: "3/3" } as const;

describe("approvalEvidence", () => {
  test("a gate repair is named as an unreviewed diff (nax#2548)", () => {
    const lines = approvalEvidence({ record: { ...record, gateRepairRounds: 1 }, stories: [] }, ci, 0);
    expect(lines).toContain(
      "Gate repair: 1 round(s) after the final gates went red; the repair diff was not re-reviewed",
    );
  });

  test("no repair, no gate-repair line", () => {
    const lines = approvalEvidence({ record, stories: [] }, ci, 0);
    expect(lines.some((l) => l.startsWith("Gate repair"))).toBe(false);
  });
});
