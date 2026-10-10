import { describe, expect, test } from "bun:test";
import type { Finding, FinishPhaseState } from "@/finish";
import { MAX_ADVISE_ROUNDS, MAX_FIX_ATTEMPTS, MAX_INCOMPLETE_ATTEMPTS, routeReview } from "@/finish";

const st = (over: Partial<FinishPhaseState> = {}): FinishPhaseState => ({
  fixAttempts: 0,
  reviewAttempts: 1,
  incompleteAttempts: 0,
  rounds: 0,
  ...over,
});
const plain: Finding = { severity: "LOW", title: "plain", problem: "p", fix: "f" };
const judged: Finding = {
  severity: "HIGH",
  title: "judged",
  problem: "p",
  fix: "f",
  judgment: true,
  judgmentReason: "design call",
};

describe("routeReview — advise route (A1 caller 1)", () => {
  test("judged + gaps routes incomplete first: an unread review is never advised (Review Focus 4)", () => {
    const r = routeReview("quality", { findings: [judged], gaps: ["no WALK"] }, st(), { advise: true });
    expect(r.route).toBe("incomplete");
  });

  test("deliberate change, advisor OFF too: judged + gaps routes incomplete, not a judgment escalation", () => {
    expect(routeReview("quality", { findings: [judged], gaps: ["no WALK"] }, st()).route).toBe("incomplete");
  });

  test("judged + gaps past the incomplete cap escalates with the gap reason, not the judgment", () => {
    const r = routeReview(
      "quality",
      { findings: [judged], gaps: ["no WALK"] },
      st({ incompleteAttempts: MAX_INCOMPLETE_ATTEMPTS }),
      {
        advise: true,
      },
    );
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toContain("reading obligations");
  });

  test("judged findings with the advisor on route advise, carrying only the judged subset", () => {
    const r = routeReview("quality", { findings: [plain, judged], gaps: [] }, st(), { advise: true });
    expect(r.route).toBe("advise");
    expect(r.judged).toEqual([judged]);
    expect(r.findings).toEqual([plain, judged]);
  });

  test("the advise cap falls back to today's judgment escalation", () => {
    const r = routeReview("quality", { findings: [judged], gaps: [] }, st({ adviseRounds: MAX_ADVISE_ROUNDS }), {
      advise: true,
    });
    expect(r).toEqual({ route: "escalate", findings: [judged], escalationReason: "design call" });
  });

  test("advisor off: judged findings escalate exactly as before", () => {
    expect(routeReview("spec", { findings: [plain, judged], gaps: [] }, st())).toEqual({
      route: "escalate",
      findings: [plain, judged],
      escalationReason: "design call",
    });
  });

  test("no judged findings: clean / fix / cap unchanged", () => {
    expect(routeReview("spec", { findings: [], gaps: [] }, st(), { advise: true }).route).toBe("clean");
    expect(routeReview("spec", { findings: [plain], gaps: [] }, st(), { advise: true }).route).toBe("fix");
    expect(
      routeReview("spec", { findings: [plain], gaps: [] }, st({ fixAttempts: MAX_FIX_ATTEMPTS }), { advise: true })
        .route,
    ).toBe("escalate");
  });
});
