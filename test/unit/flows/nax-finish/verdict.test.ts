import { describe, expect, test } from "bun:test";
import { parseFixVerdict, parseReviewVerdict } from "@flows/nax-finish/verdict";

// The real 927-byte reply that killed flow run 2026-08-05T154112386Z-nax-finish-600cf3f3
// on rs-stock/pipeline-run-chat-context. Not a synthetic "not json" string: the point is
// that a chatty reviewer emits no brace at all, which defeats every extractJsonObject tier.
const REAL_UNPARSEABLE =
  "Good, not a concern — self-contained change with a matching doc comment. " +
  "Let's check the Python test files briefly for pipeline.py resolver, and the " +
  "`apps/api/_pipeline_adapter.py` registration for unused import warnings etc." +
  "Good, that exists as expected. Now let's check the gate-blocked probing logic once " +
  "more and the `measureForNode`/`findGateBlocker` for edge cases against the AC that " +
  '"does not render the gate\'s own output payload" — seems fine. I have enough for ' +
  "findings.Reported two findings: a HIGH-confidence correctness regression (screen/" +
  "backtest chat context now emits `Strategy: undefined | Universe: undefined`).";

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
});
