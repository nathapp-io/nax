import { describe, expect, test } from "bun:test";
import { makeAdviceDecision } from "@test/helpers";
import type { Advisor, QuestionDraft } from "@/advisor";
import {
  askApproval,
  ciReason,
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
  ci: "green",
  stories: [story("US-001")],
  flagged: 0,
  branchReviewRan: true,
};

describe("readinessReasons (spec §7.8, P4-R6)", () => {
  test("all conditions hold -> no reasons", () => {
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

  // US-001: an unreadable CI state whose wait reported its own detail carries that detail alone.
  test("AC-9: an unavailable CI with a detail is the only reason", () => {
    expect(readinessReasons({ ...READY, ci: "unavailable", ciDetail: "gh: 502" })).toEqual(["gh: 502"]);
  });

  // US-003: strict green — a CI that is still pending is a reason, so the PR stays a draft.
  test("AC-7: a pending CI is a readiness reason", () => {
    expect(readinessReasons({ ...READY, ci: "pending" })).toEqual(["CI still pending after the wait"]);
    expect(readinessReasons({ ...READY, ci: "pending", ciDetail: "no CI result within 1200000ms" })).toEqual([
      "no CI result within 1200000ms",
    ]);
  });
});

/** US-001: the CI sentence extracted from `readinessReasons`, so the verdict names the same text. */
describe("ciReason (US-001)", () => {
  test("AC-5: failed is always the same sentence, whatever the wait said", () => {
    expect(ciReason("failed")).toBe("CI failed");
    expect(ciReason("failed", "1 check failed")).toBe("CI failed");
  });

  test("AC-6: a detail-bearing state returns the wait's own text", () => {
    expect(ciReason("conflicting", "PR #9 has merge conflicts")).toBe("PR #9 has merge conflicts");
  });

  test("AC-7: conflicting with no detail falls back to its default sentence", () => {
    expect(ciReason("conflicting")).toBe("PR has merge conflicts with its base branch");
  });

  test("the other detail-bearing states keep their defaults too", () => {
    expect(ciReason("no-checks")).toBe("no CI check was reported");
    expect(ciReason("no-checks", "no CI check reported within 2m 0s")).toBe("no CI check reported within 2m 0s");
    expect(ciReason("unavailable")).toBe("CI status unavailable");
    expect(ciReason("unavailable", "gh: auth required")).toBe("gh: auth required");
  });

  // US-003: strict green — only a green (or skipped) CI adds no reason; pending blocks.
  test("AC-3: a pending CI carries the wait's own detail", () => {
    expect(ciReason("pending", "no CI result within 1200000ms")).toBe("no CI result within 1200000ms");
  });

  test("AC-4: a pending CI with no detail falls back to its default sentence", () => {
    expect(ciReason("pending")).toBe("CI still pending after the wait");
  });

  test.each(["green", "skipped"] as const)("AC-5/AC-6: %s blocks nothing", (ci) => {
    expect(ciReason(ci)).toBeUndefined();
  });

  test("no CI state at all blocks nothing", () => {
    expect(ciReason(undefined)).toBeUndefined();
    expect(ciReason(undefined, "ignored")).toBeUndefined();
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
    expect(out).toEqual({ approved: true, rationale: "clean", decisionId: "D-1" });
    expect(seen[0]?.kind).toBe("finish-approval");
    expect(seen[0]?.options.map((o) => o.type)).toEqual(["approve", "hold"]);
    expect(seen[0]?.evidence.map((e) => e.text)).toEqual(["Stories: US-001 complete"]);
  });

  // AC-16 (nax#2666): the question is asked before the push, so it says CI has not run yet instead of
  // claiming every condition holds.
  test("AC-16: the summary names CI as the one condition still outstanding", async () => {
    const seen: QuestionDraft[] = [];
    await askApproval(
      advisor({ decision: makeAdviceDecision({ action: { type: "approve" }, rationale: "clean" }) }, seen),
      { feature: "f", evidence: [] },
    );
    expect(seen[0]?.summary).toBe(
      "Approve the workflow PR for f? Every deterministic ready condition except CI holds. CI runs on the pushed head after this ruling, and the PR is ready only when it is green.",
    );
  });

  test("hold, no decision, or a throw -> not approved with the reason", async () => {
    const held = await askApproval(
      advisor({ decision: makeAdviceDecision({ action: { type: "hold", reason: "x" }, rationale: "risky" }) }),
      { feature: "f", evidence: [] },
    );
    expect(held).toEqual({ approved: false, rationale: "advisor held: risky", decisionId: "D-1" });
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

/**
 * US-001: the outcome carries the advisor's decision id, so a later stage can cite the ruling behind
 * the hold instead of only its prose. A decision that never existed carries no id at all.
 */
describe("askApproval returns the advisor decision (US-001)", () => {
  function answering(result: Awaited<ReturnType<Advisor["advise"]>> | Error): Advisor {
    return {
      advise: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
      recordReuse: async () => null,
      adviseBatch: async () => ({ kind: "residual", items: [], diagnoses: {} }),
    };
  }

  test.each([
    ["AC-8", "D-1", true, []],
    ["AC-9", "D-1", true, undefined],
    ["AC-21", "D-2", false, ["src/a.ts"]],
  ] as const)("inspected files %s", async (_ac, id, approved, files) => {
    const fields = files === undefined ? {} : { inspectedFiles: [...files] };
    const out = await askApproval(
      answering({
        decision: makeAdviceDecision({
          id,
          action: approved ? { type: "approve" } : { type: "hold", reason: "risky" },
          rationale: approved ? "clean" : "risky",
          ...fields,
        }),
      }),
      { feature: "f", evidence: [] },
    );
    expect(out).toEqual({ approved, rationale: approved ? "clean" : "advisor held: risky", decisionId: id, ...fields });
  });

  test("AC-1: an approve decision returns its id", async () => {
    const out = await askApproval(
      answering({ decision: makeAdviceDecision({ id: "D-7", action: { type: "approve" }, rationale: "clean" }) }),
      { feature: "f", evidence: [] },
    );
    expect(out).toEqual({ approved: true, rationale: "clean", decisionId: "D-7" });
  });

  test("AC-2: a hold decision returns its id with the held rationale", async () => {
    const out = await askApproval(
      answering({
        decision: makeAdviceDecision({ id: "D-1", action: { type: "hold", reason: "x" }, rationale: "risky" }),
      }),
      { feature: "f", evidence: [] },
    );
    expect(out).toEqual({ approved: false, rationale: "advisor held: risky", decisionId: "D-1" });
  });

  test("AC-3: no decision carries no decisionId key", async () => {
    const out = await askApproval(answering({ decision: null, fallbackReason: "all models failed" }), {
      feature: "f",
      evidence: [],
    });
    expect(out).toEqual({ approved: false, rationale: "advisor unavailable: all models failed" });
    expect("decisionId" in out).toBe(false);
  });

  test("AC-4: a throwing advisor carries no decisionId key", async () => {
    const out = await askApproval(answering(new Error("boom")), { feature: "f", evidence: [] });
    expect(out.rationale).toBe("advisor unavailable: boom");
    expect("decisionId" in out).toBe(false);
  });
});

describe("readinessReasons — iteration cap (nax#2706)", () => {
  test("names the iteration limit and the pending stories next to the not-run reason", () => {
    const reasons = readinessReasons({
      ...READY,
      stories: [story("US-020"), story("US-021", { state: "not-run" }), story("US-022", { state: "not-run" })],
      iterationCap: { pendingIds: ["US-021", "US-022"] },
    });

    expect(reasons).toEqual([
      "iteration cap reached: the story loop hit its iteration limit with 2 stories pending (US-021, US-022)",
      "stories not run: US-021, US-022",
    ]);
  });

  test("no cap stop adds no reason", () => {
    expect(readinessReasons({ ...READY, iterationCap: undefined })).toEqual([]);
  });
});
