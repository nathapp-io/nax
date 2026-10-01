import { describe, expect, test } from "bun:test";
import type { AcceptanceGateResult, Finding, FinishPhaseState, QualityGateResult } from "@/finish";
import {
  gateCommitRoute,
  MAX_FIX_ATTEMPTS,
  MAX_INCOMPLETE_ATTEMPTS,
  partitionTestFiles,
  routeAcceptance,
  routeQualityGates,
  routeReview,
} from "@/finish";

const FINDING: Finding = { severity: "HIGH", title: "t", problem: "p", fix: "f" };

const zeroedState = (): FinishPhaseState => ({
  fixAttempts: 0,
  reviewAttempts: 0,
  incompleteAttempts: 0,
  rounds: 0,
});

describe("routeReview", () => {
  // Ported from test/unit/flows/nax-finish/verdict.test.ts's `routeReview`
  // describe block. Every `reprompt` case is dropped (D2.2): there is no
  // reprompt route any more, and `outcome` here is already parsed, so an
  // unparseable reply is plan 3's problem, not this function's.

  test("still routes clean when there are no findings", () => {
    const r = routeReview("quality", { findings: [], gaps: [] }, zeroedState());
    expect(r.route).toBe("clean");
  });

  test("still routes fix when there are findings under the cap", () => {
    const r = routeReview("quality", { findings: [FINDING], gaps: [] }, zeroedState());
    expect(r.route).toBe("fix");
  });

  test("still escalates when findings persist past the fix cap", () => {
    const st = { ...zeroedState(), fixAttempts: MAX_FIX_ATTEMPTS };
    const r = routeReview("quality", { findings: [FINDING], gaps: [] }, st);
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toContain("fix attempts");
  });

  // A reviewer that produced NO output at all is not an approval — there is
  // no reprompt path here, because a step that emitted nothing has no reply
  // to quote back. A human is the only remaining reader.
  test("an absent outcome escalates and never reads findings", () => {
    const r = routeReview("quality", undefined, zeroedState());
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toContain("no verdict");
    expect(r.findings).toEqual([]);
  });

  test("a judgment-marked finding escalates, even with fixAttempts: 0", () => {
    const judged: Finding = { ...FINDING, judgment: true, judgmentReason: "two valid designs, pick one" };
    const r = routeReview("quality", { findings: [judged], gaps: [] }, zeroedState());
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toBe("two valid designs, pick one");
  });

  test("a judgment-marked finding with no reason falls back to a generic message naming the title", () => {
    const judged: Finding = { ...FINDING, title: "Design call", judgment: true };
    const r = routeReview("quality", { findings: [judged], gaps: [] }, zeroedState());
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toBe("Needs human judgment: Design call");
  });

  test("gaps under the incomplete cap route incomplete, not escalate", () => {
    const r = routeReview("spec", { findings: [], gaps: ["never opened the caller"] }, zeroedState());
    expect(r.route).toBe("incomplete");
  });

  test("gaps at the incomplete cap escalate with a phase-named reason", () => {
    const st = { ...zeroedState(), incompleteAttempts: MAX_INCOMPLETE_ATTEMPTS };
    const r = routeReview("spec", { findings: [], gaps: ["never opened the caller"] }, st);
    expect(r.route).toBe("escalate");
    expect(r.escalationReason).toBe("spec review never discharged its reading obligations: never opened the caller");
  });

  // A clean review (zero findings) with unresolved gaps must never read as
  // `clean` — the gap check runs first, so a reviewer that skipped its
  // evidence sections does not get to approve just because it also found
  // nothing wrong.
  test("a clean review with gaps routes incomplete, never clean", () => {
    const r = routeReview("quality", { findings: [], gaps: ["skipped WALK section"] }, zeroedState());
    expect(r.route).toBe("incomplete");
    expect(r.route).not.toBe("clean");
  });

  test("a judgment finding takes priority over an under-cap fix route", () => {
    const judged: Finding = { ...FINDING, judgment: true, judgmentReason: "needs a human" };
    const r = routeReview("quality", { findings: [judged, FINDING], gaps: [] }, zeroedState());
    expect(r.route).toBe("escalate");
  });
});

describe("routeAcceptance", () => {
  const passedResult = (overrides: Partial<AcceptanceGateResult> = {}): AcceptanceGateResult => ({
    passed: true,
    ran: 1,
    missing: [],
    output: "ok",
    ...overrides,
  });

  test("a passing run with nothing missing proceeds", () => {
    const r = routeAcceptance(passedResult(), zeroedState());
    expect(r.route).toBe("proceed");
  });

  test("a passing run with a missing acceptance target escalates", () => {
    const r = routeAcceptance(passedResult({ missing: ["pkg-a"] }), zeroedState());
    expect(r.route).toBe("escalate");
    expect(r.reason).toBe("Acceptance test never generated for: pkg-a — that package's contract is unverified.");
  });

  test("a passing run that ran nothing at all escalates", () => {
    const r = routeAcceptance(passedResult({ ran: 0 }), zeroedState());
    expect(r.route).toBe("escalate");
  });

  test("a failing run under the fix cap routes fix", () => {
    const r = routeAcceptance(passedResult({ passed: false }), zeroedState());
    expect(r.route).toBe("fix");
  });

  test("a failing run past the fix cap escalates with the byte-identical reason", () => {
    const st = { ...zeroedState(), fixAttempts: MAX_FIX_ATTEMPTS };
    const r = routeAcceptance(passedResult({ passed: false }), st);
    expect(r.route).toBe("escalate");
    expect(r.reason).toBe(`Acceptance tests still failing after ${MAX_FIX_ATTEMPTS} fix attempts.`);
  });
});

describe("routeQualityGates", () => {
  const passedResult = (overrides: Partial<QualityGateResult> = {}): QualityGateResult => ({
    passed: true,
    ran: ["test"],
    failing: [],
    output: "ok",
    ...overrides,
  });

  test("a passing run routes green", () => {
    const r = routeQualityGates(passedResult(), zeroedState());
    expect(r.route).toBe("green");
  });

  test("nothing configured escalates with the byte-identical reason", () => {
    const r = routeQualityGates(passedResult({ passed: false, ran: [] }), zeroedState());
    expect(r.route).toBe("escalate");
    expect(r.reason).toBe("No quality.commands configured in .nax/config.json — nax-finish verified nothing.");
  });

  test("a failing run under the fix cap routes fix", () => {
    const r = routeQualityGates(passedResult({ passed: false, failing: ["test"] }), zeroedState());
    expect(r.route).toBe("fix");
  });

  test("a failing run past the fix cap escalates with the byte-identical reason", () => {
    const st = { ...zeroedState(), fixAttempts: MAX_FIX_ATTEMPTS };
    const r = routeQualityGates(passedResult({ passed: false, failing: ["test"] }), st);
    expect(r.route).toBe("escalate");
    expect(r.reason).toBe(`Quality gates still failing after ${MAX_FIX_ATTEMPTS} fix attempts (test).`);
  });
});

describe("partitionTestFiles", () => {
  test("with no patterns, everything classifies as non-test", () => {
    const r = partitionTestFiles(["src/a.ts", "test/unit/a.test.ts"], []);
    expect(r.test).toEqual([]);
    expect(r.nonTest).toEqual(["src/a.ts", "test/unit/a.test.ts"]);
  });

  test("classifies matched paths as test, the rest as non-test", () => {
    const r = partitionTestFiles(["src/a.ts", "test/unit/a.test.ts"], ["\\.test\\.ts$"]);
    expect(r.test).toEqual(["test/unit/a.test.ts"]);
    expect(r.nonTest).toEqual(["src/a.ts"]);
  });

  test("skips an unparseable regex source rather than throwing", () => {
    expect(() => partitionTestFiles(["src/a.ts"], ["("])).not.toThrow();
    const r = partitionTestFiles(["src/a.ts"], ["("]);
    expect(r.nonTest).toEqual(["src/a.ts"]);
  });
});

describe("gateCommitRoute", () => {
  test("nothing committed is unchanged", () => {
    expect(gateCommitRoute(false, [], [])).toBe("unchanged");
  });

  test("an unresolvable post-commit SHA (null files) is changed", () => {
    expect(gateCommitRoute(true, null, [])).toBe("changed");
  });

  test("a committed change with an empty file list is changed", () => {
    expect(gateCommitRoute(true, [], [])).toBe("changed");
  });

  test("every touched path matching a test pattern is tests-only", () => {
    expect(gateCommitRoute(true, ["test/unit/a.test.ts"], ["\\.test\\.ts$"])).toBe("tests-only");
  });

  test("any non-test path in the commit is changed", () => {
    expect(gateCommitRoute(true, ["src/a.ts", "test/unit/a.test.ts"], ["\\.test\\.ts$"])).toBe("changed");
  });

  test("with no test patterns, a committed change cannot be classified and is changed", () => {
    expect(gateCommitRoute(true, ["test/unit/a.test.ts"], [])).toBe("changed");
  });
});
