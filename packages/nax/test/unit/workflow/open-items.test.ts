import { describe, expect, test } from "bun:test";
import { newFeatureRecord } from "@/workflow/feature-record";
import { buildOpenItems, buildVerdict } from "@/workflow/open-items";
import type { WorkflowFeatureRecord, WorkflowRuling } from "@/workflow/types";

const B3 = {
  id: "B3",
  kind: "spec" as const,
  severity: "important" as const,
  issue: "x".repeat(500),
  file: "src/p.ts",
  line: 9,
  suggestion: "return the id",
};
const ruling = (over: Partial<WorkflowRuling>): WorkflowRuling => ({
  findingId: "B3",
  action: "hold",
  text: "t",
  why: "needs a human",
  costIfWrong: "c",
  source: "advisor",
  ...over,
});
const rec = (over: Partial<WorkflowFeatureRecord>): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  ...over,
});

describe("buildOpenItems (#2496)", () => {
  test("a held finding is open with its evidence in full and its ruling", () => {
    const [item] = buildOpenItems(rec({ reviewOpen: [B3], rulings: [ruling({ decisionId: "D-4" })] }));
    expect(item).toEqual({
      id: "B3",
      kind: "ruling",
      severity: "important",
      file: "src/p.ts",
      line: 9,
      issue: B3.issue,
      suggestion: "return the id",
      ruling: { action: "hold", why: "needs a human", decisionId: "D-4" },
    });
  });

  test("an unflagged waive closes the finding; a flagged waive keeps it open", () => {
    expect(buildOpenItems(rec({ reviewOpen: [B3], rulings: [ruling({ action: "waive" })] }))).toEqual([]);
    const flagged = buildOpenItems(
      rec({ reviewOpen: [B3], rulings: [ruling({ action: "waive", needsHumanConfirm: true })] }),
    );
    expect(flagged[0]?.kind).toBe("ruling");
  });

  test("an unruled finding is kind finding; cannot-verify and red final gates are listed", () => {
    const items = buildOpenItems(
      rec({
        reviewOpen: [B3],
        cannotVerify: ["CI-only path"],
        finalGates: { ran: ["lint"], failing: ["lint"] },
        finalGateFindings: [{ kind: "gate", severity: "important", issue: "repo gate lint failed:\nno-var" }],
      }),
    );
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ["B3", "finding"],
      ["_run:cv1", "cannot-verify"],
      ["lint", "gate"],
    ]);
    expect(items[2]?.issue).toBe("repo gate lint failed:\nno-var");
  });
});

describe("buildVerdict (#2496)", () => {
  test("undefined before publish", () => {
    expect(buildVerdict(rec({}))).toBeUndefined();
  });

  test("workflowPassed is false while a finding, ruling or gate is open, and ignores cannot-verify", () => {
    const base = { outcome: "draft" as const, passed: true, reasons: ["1 ruling(s) flagged for a human"] };
    expect(buildVerdict(rec({ ...base, reviewOpen: [B3], rulings: [ruling({})] }))?.workflowPassed).toBe(false);
    expect(buildVerdict(rec({ ...base, outcome: "ready", reasons: [], cannotVerify: ["x"] }))?.workflowPassed).toBe(
      true,
    );
    expect(buildVerdict(rec({ ...base, outcome: "ready", reasons: [], passed: false }))?.workflowPassed).toBe(false);
  });
});
