import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import type { Advisor, QuestionDraft } from "@/advisor";
import {
  askApproval,
  describeUnread,
  featurePassed,
  flaggedCount,
  type ReadinessFacts,
  readinessReasons,
} from "@/workflow/approval";
import type { StorySummary } from "@/workflow/types";

const story = (id: string, over: Partial<StorySummary> = {}): StorySummary => ({
  id,
  title: id,
  state: "complete",
  rounds: 0,
  unreviewed: false,
  flagged: 0,
  ...over,
});
const READY: ReadinessFacts = {
  finalGates: { ran: ["build", "test"], failing: [] },
  ci: "pending",
  stories: [story("US-001")],
  flagged: 0,
  branchReviewRan: true,
};

describe("readinessReasons (spec §7.8, P4-R6)", () => {
  test("all conditions hold -> no reasons; CI pending does not block (W-R9)", () => {
    expect(readinessReasons(READY)).toEqual([]);
  });

  test.each([
    [{ finalGates: { ran: [], failing: [] } }, "no quality commands configured — nothing was verified"],
    [{ finalGates: undefined }, "no quality commands configured — nothing was verified"],
    [{ finalGates: { ran: ["lint"], failing: ["lint"] } }, "gates red: lint"],
    [{ ci: "failed" as const }, "CI failed"],
    [{ ci: "conflicting" as const, ciDetail: "PR has merge conflicts with main" }, "PR has merge conflicts with main"], // AC-18
    [{ ci: "conflicting" as const }, "PR has merge conflicts with its base branch"],
    [{ ci: "no-checks" as const }, "no CI check was reported"], // AC-19
    [{ ci: "unavailable" as const }, "CI status unavailable"], // nax#2550
    [{ ci: "unavailable" as const, ciDetail: "CI status unavailable: gh: auth" }, "CI status unavailable: gh: auth"],
    [{ ci: "no-checks" as const, ciDetail: "no CI check reported within 2m 0s" }, "no CI check reported within 2m 0s"],
    [{ stories: [story("US-001", { state: "complete-gate-open" })] }, "stories gate-open: US-001"],
    [{ stories: [story("US-002", { state: "not-run" })] }, "stories not run: US-002"],
    [{ flagged: 2 }, "2 ruling(s) flagged for a human"],
    [{ branchReviewRan: false }, "branch review did not run"],
    [{ reReviewSkipped: true }, "branch re-review did not run: the fix commits are unreviewed"], // nax#2550
  ])("%p -> %s", (over, reason) => {
    expect(readinessReasons({ ...READY, ...over })).toEqual([reason]);
  });

  // US-003 (nax#2532): the branch review ran but did not read every changed file — a draft, not a ready PR.
  test("an incomplete branch review keeps the PR a draft (AC-18)", () => {
    expect(readinessReasons({ ...READY, branchReviewUnread: ["a.ts"] })).toEqual([
      "branch review did not read 1 changed file(s): a.ts",
    ]);
  });

  test("an empty unread list adds no reason (AC-19)", () => {
    expect(readinessReasons({ ...READY, branchReviewUnread: [] })).toEqual([]);
  });

  test("the unread reason comes after the branch-review-did-not-run reason", () => {
    expect(readinessReasons({ ...READY, branchReviewRan: false, branchReviewUnread: ["a.ts"] })).toEqual([
      "branch review did not run",
      "branch review did not read 1 changed file(s): a.ts",
    ]);
  });
});

describe("describeUnread (US-003)", () => {
  test("names the count and every path (AC-16)", () => {
    expect(describeUnread(["a.ts", "b.ts"])).toBe("branch review did not read 2 changed file(s): a.ts, b.ts");
  });

  test("lists at most five paths and counts the rest (AC-17)", () => {
    const seven = ["p1.ts", "p2.ts", "p3.ts", "p4.ts", "p5.ts", "p6.ts", "p7.ts"];
    expect(describeUnread(seven)).toBe(
      "branch review did not read 7 changed file(s): p1.ts, p2.ts, p3.ts, p4.ts, p5.ts, +2 more",
    );
  });

  test("exactly five paths need no remainder", () => {
    expect(describeUnread(["p1.ts", "p2.ts", "p3.ts", "p4.ts", "p5.ts"])).toBe(
      "branch review did not read 5 changed file(s): p1.ts, p2.ts, p3.ts, p4.ts, p5.ts",
    );
  });
});

describe("featurePassed (P4-R13)", () => {
  test("true with green gates and complete stories, even with nothing configured", () => {
    expect(featurePassed(READY)).toBe(true);
    expect(featurePassed({ ...READY, finalGates: { ran: [], failing: [] } })).toBe(true);
  });

  test("false on a failing gate, a gate-open story or a not-run story", () => {
    expect(featurePassed({ ...READY, finalGates: { ran: ["lint"], failing: ["lint"] } })).toBe(false);
    expect(featurePassed({ ...READY, stories: [story("US-1", { state: "complete-gate-open" })] })).toBe(false);
    expect(featurePassed({ ...READY, stories: [story("US-1", { state: "not-run" })] })).toBe(false);
  });
});

describe("flaggedCount", () => {
  test("story flags + pre-flight holds + flagged branch rulings", () => {
    const n = flaggedCount(
      [story("US-1", { flagged: 1 }), story("US-2", { flagged: 2 })],
      {
        schemaVersion: 1,
        storyIds: ["US-1", "US-2"],
        overlap: [],
        conflicts: [
          { questionId: "Q1", storyIds: ["US-1"], summary: "s", decisionId: "D-1", action: "hold" },
          { questionId: "Q2", storyIds: ["US-2"], summary: "s", decisionId: "D-2", action: "supersede" },
        ],
      },
      [
        {
          findingId: "B1",
          action: "waive",
          text: "t",
          why: "w",
          costIfWrong: "c",
          source: "advisor",
          needsHumanConfirm: true,
        },
        { findingId: "B2", action: "defer", text: "t", why: "w", costIfWrong: "c", source: "advisor" },
      ],
    );
    expect(n).toBe(5);
  });
});

describe("askApproval (P4-R10)", () => {
  function advisor(result: Awaited<ReturnType<Advisor["advise"]>> | Error, seen: QuestionDraft[] = []): Advisor {
    return {
      advise: async (q) => {
        seen.push(q);
        if (result instanceof Error) throw result;
        return result;
      },
      recordReuse: async () => null,
      adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
    };
  }

  test("asks finish-approval with an approve/hold menu and the evidence", async () => {
    const seen: QuestionDraft[] = [];
    const out = await askApproval(
      advisor({ decision: makeAdviceDecision({ action: { type: "approve" }, rationale: "clean" }) }, seen),
      { feature: "f", evidence: ["Stories: US-001 complete"] },
    );
    expect(out).toEqual({ approved: true, rationale: "clean" });
    expect(seen[0]?.kind).toBe("finish-approval");
    expect(seen[0]?.options.map((o) => o.type)).toEqual(["approve", "hold"]);
    expect(seen[0]?.evidence.map((e) => e.text)).toEqual(["Stories: US-001 complete"]);
  });

  test("hold, no decision, or a throw -> not approved with the reason", async () => {
    const held = await askApproval(
      advisor({ decision: makeAdviceDecision({ action: { type: "hold", reason: "x" }, rationale: "risky" }) }),
      { feature: "f", evidence: [] },
    );
    expect(held).toEqual({ approved: false, rationale: "advisor held: risky" });
    expect(
      await askApproval(advisor({ decision: null, fallbackReason: "all models failed" }), {
        feature: "f",
        evidence: [],
      }),
    ).toEqual({
      approved: false,
      rationale: "advisor unavailable: all models failed",
    });
    expect((await askApproval(advisor(new Error("boom")), { feature: "f", evidence: [] })).rationale).toBe(
      "advisor unavailable: boom",
    );
  });
});
