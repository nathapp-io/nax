import { describe, expect, test } from "bun:test";
import {
  MAX_FIX_ATTEMPTS,
  MAX_REPROMPT_ATTEMPTS,
  parseFixVerdict,
  parseReviewVerdict,
  repromptCount,
  routeReview,
} from "@flows/nax-finish/verdict";
import { makeFlowStep, makeFlowSteps, reviewRounds } from "@test/helpers";
import type { FlowStepRecord } from "acpx/flows";

// The real reply that killed flow run 2026-08-05T154112386Z-nax-finish-600cf3f3 on
// rs-stock, with private identifiers replaced by generic equivalents — the shape
// (long, chatty, no brace anywhere) is authentic, only the names are not. Not a
// synthetic "not json" string: the point is that a chatty reviewer emits no brace at
// all, which defeats every extractJsonObject tier.
const REAL_UNPARSEABLE =
  "Good, not a concern — self-contained change with a matching doc comment. " +
  "Let's check the test files briefly for the request-routing resolver, and the " +
  "`src/server/request_handler.py` registration for unused import warnings etc." +
  "Good, that exists as expected. Now let's check the gate-blocked probing logic once " +
  "more and the `computeNodeMetrics`/`locateBlockingGate` for edge cases against the AC that " +
  '"does not render the gate\'s own output payload" — seems fine. I have enough for ' +
  "findings.Reported two findings: a HIGH-confidence correctness regression (the " +
  "dashboard summary panel now emits `Label: undefined | Category: undefined`).";

const FINDING = { severity: "HIGH", title: "t", problem: "p", fix: "f" };

describe("parseReviewVerdict", () => {
  test("parses a bare JSON object", () => {
    const v = parseReviewVerdict(JSON.stringify({ route: "proceed", findings: [FINDING] }));
    expect(v.route).toBe("proceed");
    expect(v.findings).toHaveLength(1);
  });

  test("rewrites proceed-with-no-findings to clean", () => {
    expect(parseReviewVerdict(JSON.stringify({ route: "proceed", findings: [] })).route).toBe("clean");
  });

  test("honours an explicit escalate route", () => {
    const v = parseReviewVerdict(JSON.stringify({ route: "escalate", findings: [], escalationReason: "r" }));
    expect(v.route).toBe("escalate");
    expect(v.escalationReason).toBe("r");
  });

  test("still parses fenced JSON", () => {
    const v = parseReviewVerdict('```json\n{"route":"proceed","findings":[]}\n```');
    expect(v.route).toBe("clean");
  });

  test("still parses JSON embedded in prose", () => {
    const v = parseReviewVerdict(`Here you go:\n{"route":"proceed","findings":[]}\nDone.`);
    expect(v.route).toBe("clean");
  });

  test("routes reprompt on the real unparseable reply, with no findings", () => {
    const v = parseReviewVerdict(REAL_UNPARSEABLE);
    expect(v.route).toBe("reprompt");
    expect(v.findings).toEqual([]);
  });

  test("carries a bounded tail of the raw reply", () => {
    const v = parseReviewVerdict("x".repeat(2000));
    expect(v.raw).toBeDefined();
    expect((v.raw as string).length).toBeLessThanOrEqual(500);
  });

  test("routes reprompt on empty output", () => {
    expect(parseReviewVerdict("").route).toBe("reprompt");
  });
});

const BLOCK_REPLY = `## TOUCHPOINTS
- src/a.ts:run — the only caller

## WALK
AC-1 Covered — done

## FINDINGS
[HIGH] Broken thing
  Problem: a.ts:1 breaks.
  Fix: unbreak it.
`;

describe("parseReviewVerdict — block format", () => {
  test("parses severity blocks and routes proceed", () => {
    const v = parseReviewVerdict(BLOCK_REPLY);
    expect(v.route).toBe("proceed");
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0].title).toBe("Broken thing");
  });

  test("carries the audit sections through for the gate to read", () => {
    const v = parseReviewVerdict(BLOCK_REPLY);
    expect(v.sawTouchpointsSection).toBe(true);
    expect(v.sawWalkSection).toBe(true);
    expect(v.touchpoints?.[0]?.path).toBe("src/a.ts");
    expect(v.walk).toHaveLength(1);
  });

  test("No findings. routes clean", () => {
    expect(parseReviewVerdict("## FINDINGS\nNo findings.").route).toBe("clean");
  });

  test("a judgment-marked finding escalates, and names its reason", () => {
    const v = parseReviewVerdict(
      "[MEDIUM] Design call\n  Problem: p\n  Fix: f\n  Judgment: yes — two valid designs, pick one\n",
    );
    expect(v.route).toBe("escalate");
    expect(v.escalationReason).toContain("two valid designs");
  });

  test("findings without a judgment marker never escalate", () => {
    expect(parseReviewVerdict(BLOCK_REPLY).route).toBe("proceed");
  });

  test("the real unparseable reply still routes reprompt", () => {
    expect(parseReviewVerdict(REAL_UNPARSEABLE).route).toBe("reprompt");
  });
});

describe("parseFixVerdict", () => {
  test("parses JSON like the review parser", () => {
    expect(parseFixVerdict(JSON.stringify({ route: "proceed", findings: [FINDING] })).findings).toHaveLength(1);
  });

  test("never throws and never routes reprompt on garbage", () => {
    const v = parseFixVerdict(REAL_UNPARSEABLE);
    expect(v.route).toBe("proceed");
    expect(v.findings).toEqual([]);
  });

  test("never throws on empty output", () => {
    expect(parseFixVerdict("").route).toBe("proceed");
  });

  test("keeps the dispositions it was given", () => {
    const v = parseFixVerdict("## DISPOSITIONS\n[1] fixed\n[2] rejected — evidence: test/a.test.ts:9\n");
    expect(v.dispositions).toHaveLength(2);
    expect(v.dispositions?.[1]).toMatchObject({ index: 2, disposition: "rejected" });
    expect(v.route).toBe("proceed");
  });

  test("still proceeds on an unreadable fix reply", () => {
    const v = parseFixVerdict("I did the thing.");
    expect(v.route).toBe("proceed");
    expect(v.dispositions ?? []).toEqual([]);
  });
});

const stepsCtx = (steps: FlowStepRecord[]) => ({ state: { steps }, outputs: {} });
const routeCtx = (verdict: unknown, steps: FlowStepRecord[] = []) => ({
  outputs: { review_quality: verdict },
  state: { steps },
});
const REPROMPT = { route: "reprompt", findings: [] };
const REPROMPT_STEP = makeFlowStep("review_quality", { output: REPROMPT });
const CLEAN_STEP = makeFlowStep("review_quality", { output: { route: "clean", findings: [] } });

describe("repromptCount", () => {
  test("is zero with no steps", () => {
    expect(repromptCount(stepsCtx([]), "quality")).toBe(0);
  });

  test("ignores legitimate review re-entries that produced a real verdict", () => {
    expect(repromptCount(stepsCtx([CLEAN_STEP, makeFlowStep("commit_quality"), CLEAN_STEP]), "quality")).toBe(0);
  });

  test("counts only steps whose output routed reprompt", () => {
    expect(repromptCount(stepsCtx([CLEAN_STEP, REPROMPT_STEP]), "quality")).toBe(1);
  });

  test("does not count the other phase's reprompts", () => {
    expect(repromptCount(stepsCtx([REPROMPT_STEP]), "spec")).toBe(0);
  });
});

describe("routeReview", () => {
  test("a reprompt verdict is NEVER routed clean", () => {
    // Regression guard. A reprompt verdict has zero findings, so an ordering
    // slip that checks `findings.length === 0` first would call an unread
    // review "clean" and open a PR having verified nothing — a silent false
    // green, strictly worse than the crash this change removes.
    const r = routeReview(routeCtx({ route: "reprompt", findings: [], raw: "prose" }), "quality");
    expect(r.route).not.toBe("clean");
    expect(r.route).toBe("reprompt");
  });

  // `reviewRounds(phase, N, …)` builds the history acpx really produces: round
  // N carries N recorded review steps, not N-1, because the step that triggered
  // `route_<phase>` is recorded before `route_<phase>` runs. The round-1 case
  // FAILS under the old `attempts < MAX_REPROMPT_ATTEMPTS` comparison, which
  // escalated on the very first unparseable reply instead of retrying.
  test("reprompts on the first unparseable reply (round 1: 1 reprompt step already recorded)", () => {
    const steps = reviewRounds("quality", 1, REPROMPT);
    const r = routeReview(routeCtx({ route: "reprompt", findings: [], raw: "some prose" }, steps), "quality");
    expect(r.route).toBe("reprompt");
  });

  test("escalates on the second consecutive unparseable reply, naming the raw tail", () => {
    const steps = reviewRounds("quality", MAX_REPROMPT_ATTEMPTS + 1, REPROMPT);
    const r = routeReview(routeCtx({ route: "reprompt", findings: [], raw: "some prose" }, steps), "quality");
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toContain("unparseable");
    expect(r.escalationReason).toContain("after 2 attempts");
    expect(r.escalationReason).toContain("some prose");
  });

  test("still routes clean when there are no findings", () => {
    expect(routeReview(routeCtx({ route: "clean", findings: [] }), "quality").route).toBe("clean");
  });

  test("still routes fix when there are findings under the cap", () => {
    expect(routeReview(routeCtx({ route: "proceed", findings: [FINDING] }), "quality").route).toBe("fix");
  });

  test("still escalates an explicit escalate verdict", () => {
    const r = routeReview(routeCtx({ route: "escalate", findings: [], escalationReason: "judgment" }), "quality");
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toBe("judgment");
  });

  test("still escalates when findings persist past the fix cap", () => {
    const steps = makeFlowSteps(Array.from({ length: MAX_FIX_ATTEMPTS }, () => "fix_quality"));
    const r = routeReview(routeCtx({ route: "proceed", findings: [FINDING] }, steps), "quality");
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toContain("fix attempts");
  });

  // A reviewer that produced NO output at all is not an approval. `ctx.outputs`
  // keeps only each node's latest output, so an absent verdict is either "the
  // node never ran" or "it died without emitting" — and in a loop the previous
  // round's clean verdict may still be sitting there. Defaulting to `findings ??
  // []` made all three read as "clean" and opened a PR having verified nothing.
  test("an absent verdict is NEVER routed clean", () => {
    const r = routeReview({ outputs: {}, state: { steps: [] } }, "quality");
    expect(r.route).not.toBe("clean");
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toContain("no verdict");
  });

  test("an absent verdict escalates rather than reusing the previous round's clean verdict", () => {
    // The stale-output case: round 1 passed clean, round 2's node emitted
    // nothing. Routing on the leftover output would silently re-approve.
    const steps = makeFlowSteps(["review_quality", "route_quality", "commit_gate"]);
    const r = routeReview({ outputs: { review_spec: { route: "clean", findings: [] } }, state: { steps } }, "quality");
    expect(r.route).toBe("escalate");
  });
});
