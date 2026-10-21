/**
 * US-002 (nax#2569): `buildOpenItems` names everything that keeps a feature from ready — the advisor
 * hold, the flagged decisions, the stories that did not finish, the blocking CI state and every reason
 * no other item explains — not only the review's findings and the red gates (#2496).
 */
import { describe, expect, test } from "bun:test";
import { readinessReasons } from "@/workflow/approval";
import { newFeatureRecord } from "@/workflow/feature-record";
import { buildOpenItems, buildVerdict } from "@/workflow/open-items";
import type { OpenItem, WorkflowFeatureRecord, WorkflowFinding } from "@/workflow/types";

const rec = (over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord => ({
  ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
  ...over,
});

/** The approval `askApproval` returns for a hold (US-001). */
const HELD = { approved: false as const, rationale: "advisor held: x", decisionId: "D-1" };

const ofKind = (items: readonly OpenItem[], kind: string): OpenItem[] => items.filter((i) => i.kind === kind);

describe("buildOpenItems: advisor items (US-002)", () => {
  test("AC-1: a held approval is an advisor item carrying its decision id", () => {
    const items = buildOpenItems(
      rec({ approval: { approved: false, rationale: "advisor held: x", decisionId: "D-1" } }),
    );
    expect(items).toContainEqual({ id: "D-1", kind: "advisor", issue: "advisor held: x" });
  });

  test("AC-2: a hold with no decision id falls back to _run:approval", () => {
    const items = buildOpenItems(rec({ approval: { approved: false, rationale: "advisor unavailable: boom" } }));
    expect(items).toContainEqual({ id: "_run:approval", kind: "advisor", issue: "advisor unavailable: boom" });
  });

  test("AC-3: an approved feature has no advisor item", () => {
    const items = buildOpenItems(rec({ approval: { approved: true, rationale: "clean", decisionId: "D-7" } }));
    expect(ofKind(items, "advisor")).toEqual([]);
  });

  test("AC-4: flagged decisions join the approval's hold, once each, in ledger order", () => {
    const items = buildOpenItems(rec({ approval: HELD, flaggedDecisions: ["D-1", "D-3"] }));
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ["D-1", "advisor"],
      ["D-3", "advisor"],
    ]);
    expect(items[1]?.issue).toStartWith("advisor decision D-3 needs a human");
  });
});

describe("buildOpenItems: story items (US-002)", () => {
  test("AC-5: only the stories that did not finish are story items", () => {
    const items = buildOpenItems(
      rec({
        storyStates: [
          { id: "US-001", state: "complete" },
          { id: "US-002", state: "complete-with-rulings" },
          { id: "US-003", state: "complete-gate-open", reason: "red: lint" },
          { id: "US-004", state: "not-run" },
        ],
      }),
    );
    expect(ofKind(items, "story").map((i) => [i.id, i.issue])).toEqual([
      ["US-003", "US-003 ended complete-gate-open: red: lint"],
      ["US-004", "US-004 did not finish"],
    ]);
  });
});

describe("buildOpenItems: CI items (US-002)", () => {
  test("AC-6: a failed CI is a ci item", () => {
    expect(buildOpenItems(rec({ ci: "failed" }))).toContainEqual({ id: "_run:ci", kind: "ci", issue: "CI failed" });
  });

  test("AC-7: a conflict carries the CI wait's own detail", () => {
    const items = buildOpenItems(rec({ ci: "conflicting", ciDetail: "PR #9 has merge conflicts" }));
    expect(items).toEqual([{ id: "_run:ci", kind: "ci", issue: "PR #9 has merge conflicts" }]);
  });

  // US-003: strict green — a pending CI is a reason, so it is an open item too.
  test("AC-8: a pending CI is a ci item", () => {
    expect(buildOpenItems(rec({ ci: "pending" }))).toContainEqual({
      id: "_run:ci",
      kind: "ci",
      issue: "CI still pending after the wait",
    });
  });

  test.each(["green", "skipped"] as const)("AC-8: %s adds no ci item", (ci) => {
    expect(ofKind(buildOpenItems(rec({ ci })), "ci")).toEqual([]);
  });
});

describe("buildOpenItems: reason items and the explained rule (US-002)", () => {
  test("AC-9: unexplained reasons are listed, numbered by their position in the record", () => {
    const items = buildOpenItems(
      rec({ reasons: ["uncommitted changes after the branch fix", "branch review did not run"] }),
    );
    expect(items).toEqual([
      { id: "_run:reason1", kind: "reason", issue: "uncommitted changes after the branch fix" },
      { id: "_run:reason2", kind: "reason", issue: "branch review did not run" },
    ]);
  });

  test("AC-10: a red gate's reason is explained by the gate item", () => {
    const items = buildOpenItems(
      rec({ finalGates: { ran: ["lint"], failing: ["lint"] }, reasons: ["gates red: lint"] }),
    );
    expect(items.map((i) => [i.id, i.kind])).toEqual([["lint", "gate"]]);
  });

  test("AC-11: every reason a listed fact produced is explained, so none is repeated", () => {
    const items = buildOpenItems(
      rec({
        ci: "failed",
        storyStates: [{ id: "US-003", state: "complete-gate-open" }],
        approval: HELD,
        reasons: ["CI failed", "stories gate-open: US-003", "advisor held: x"],
      }),
    );
    expect(ofKind(items, "reason")).toEqual([]);
  });

  test("AC-12: a flagged count the ledger backs is explained", () => {
    const items = buildOpenItems(
      rec({ reasons: ["2 ruling(s) flagged for a human"], flaggedDecisions: ["D-3", "D-4"] }),
    );
    expect(ofKind(items, "reason")).toEqual([]);
  });

  test("AC-13: a flagged count with no decision ids behind it stays a reason", () => {
    const items = buildOpenItems(rec({ reasons: ["2 ruling(s) flagged for a human"] }));
    expect(items).toEqual([{ id: "_run:reason1", kind: "reason", issue: "2 ruling(s) flagged for a human" }]);
  });

  test("AC-14: an explained reason keeps its position, so a later reason's id does not shift", () => {
    const items = buildOpenItems(
      rec({
        finalGates: { ran: ["lint"], failing: ["lint"] },
        reasons: ["gates red: lint", "branch review did not run"],
      }),
    );
    expect(ofKind(items, "reason")).toEqual([
      { id: "_run:reason2", kind: "reason", issue: "branch review did not run" },
    ]);
  });

  test("AC-15: the nothing-verified reason has no gate item, so it stays a reason", () => {
    const finalGates = { ran: [], failing: [] };
    const [nothingVerified = ""] = readinessReasons({
      finalGates,
      ci: "green",
      stories: [],
      flagged: 0,
      branchReviewRan: true,
    });
    expect(nothingVerified).toBe("no quality commands configured — nothing was verified");
    expect(buildOpenItems(rec({ finalGates, reasons: [nothingVerified] }))).toEqual([
      { id: "_run:reason1", kind: "reason", issue: nothingVerified },
    ]);
  });
});

describe("buildOpenItems: the whole list (US-002)", () => {
  test("AC-16: the kinds come out in one order", () => {
    const finding: WorkflowFinding = { id: "B1", kind: "quality", severity: "important", issue: "cap missing" };
    const items = buildOpenItems(
      rec({
        reviewOpen: [finding],
        cannotVerify: ["CI-only path"],
        finalGates: { ran: ["lint"], failing: ["lint"] },
        approval: HELD,
        storyStates: [{ id: "US-003", state: "complete-gate-open", reason: "red: lint" }],
        ci: "failed",
        reasons: ["branch review did not run"],
      }),
    );
    expect(items.map((i) => i.kind)).toEqual(["finding", "cannot-verify", "gate", "advisor", "story", "ci", "reason"]);
  });

  test("AC-17: an advisor hold never fails the workflow — only findings, rulings and gates block", () => {
    const verdict = buildVerdict(rec({ passed: true, outcome: "draft", approval: HELD }));
    expect(verdict?.workflowPassed).toBe(true);
    expect(verdict?.openItems).toContainEqual({ id: "D-1", kind: "advisor", issue: "advisor held: x" });
  });
});
